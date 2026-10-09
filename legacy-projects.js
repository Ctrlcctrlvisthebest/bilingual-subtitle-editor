import { clone, normalizeProject } from "./project.js";
function rebaseStored(project, id, patch) {
  const stored = { ...patch };
  for (const update of project.subtitle_updates || []) for (const change of update.rows || []) if (change.id === id) {
    for (const [field, value] of Object.entries(change.before)) if (JSON.stringify(stored[field]) === JSON.stringify(value)) stored[field] = change.after[field];
  }
  return stored;
}
function restoreLegacyProject(base, saved, legacy) {
  let project = clone(base), idx = 0, migrationConflicts = 0;
  if (!saved && project.editor_id === "usmp-KyLqZkfv3BU") {
    if (legacy?.revision === 3) {
      const available = new Map(project.rows.map((r) => [r.id, { ...r }])), groups = project.segmentation_updates || [], owners = /* @__PURE__ */ new Map(), decisions = /* @__PURE__ */ new Map();
      for (const group of groups) {
        for (const r of group.after) available.delete(r.id);
        for (const r of group.before) {
          available.set(r.id, { ...r });
          owners.set(r.id, group);
        }
      }
      for (const [id, patch] of Object.entries(legacy.patches || {})) {
        const stored = rebaseStored(project, id, patch);
        if (available.has(id)) Object.assign(available.get(id), stored);
        else if (stored.en !== void 0) available.set(id, { id, ...stored });
      }
      const order = legacy.order || project.segmentation_source_order || [...available.keys()], present = new Set(order);
      for (const group of groups) {
        const edited = group.before.some((r) => !present.has(r.id) || Object.entries(rebaseStored(project, r.id, legacy.patches?.[r.id] || {})).some(([f, v]) => JSON.stringify(v) !== JSON.stringify(r[f])));
        decisions.set(group, edited);
        if (edited) migrationConflicts++;
      }
      const handled = /* @__PURE__ */ new Set(), rebuilt = [];
      for (const id of order) {
        const group = owners.get(id);
        if (group && !decisions.get(group)) {
          if (!handled.has(group)) {
            rebuilt.push(...group.after.map((r) => ({ ...r })));
            handled.add(group);
          }
        } else if (available.has(id)) rebuilt.push(available.get(id));
      }
      project.rows = rebuilt;
      project.colors = Object.assign(/* @__PURE__ */ Object.create(null), project.colors, legacy.colors);
      idx = Math.max(0, Math.min(project.rows.length - 1, legacy.index || 0));
    }
  } else if (saved?.revision === project.revision) {
    for (const r of project.rows) if (saved.patches?.[r.id]) {
      const stored = rebaseStored(project, r.id, saved.patches[r.id]);
      Object.assign(r, stored);
    }
    if (saved.order) {
      const available = new Map(project.rows.map((r) => [r.id, r]));
      for (const [id, r] of Object.entries(saved.patches || {})) if (!available.has(id) && r.en !== void 0) available.set(id, { id, ...r });
      project.rows = saved.order.map((id) => available.get(id)).filter(Boolean);
    }
    if (saved.colors) project.colors = Object.assign(/* @__PURE__ */ Object.create(null), saved.colors);
    if (saved.meta) Object.assign(project, saved.meta);
    idx = Math.max(0, Math.min(project.rows.length - 1, saved.index || 0));
  }
  return { project: normalizeProject(project), index: idx, conflicts: migrationConflicts };
}
export {
  restoreLegacyProject
};
