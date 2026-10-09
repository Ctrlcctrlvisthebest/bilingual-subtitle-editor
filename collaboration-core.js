import { clone } from "./project.js";
function collabLeaderKey(groupId, token) {
  if (typeof groupId !== "string" || !/^[-a-f0-9]{36}\.[a-f0-9]{64}$/.test(groupId) || typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) {
    throw Error("组长密钥信息无效");
  }
  return "sg1_" + groupId + "." + token;
}
function collabParseLeaderKey(value) {
  const match = typeof value === "string" && value.trim().match(/^sg1_([-a-f0-9]{36}\.[a-f0-9]{64})\.([a-f0-9]{64})$/);
  if (!match) throw Error("请完整粘贴以 sg1_ 开头的组长密钥");
  return { groupId: match[1], token: match[2] };
}
const collabEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function collabMeta(project) {
  const { rows, ...meta } = project;
  return meta;
}
function collabPatch(base, project) {
  const before = new Map(base.project.rows.map((row) => [row.id, row]));
  const after = new Map(project.rows.map((row) => [row.id, row]));
  const changes = [];
  for (const id of /* @__PURE__ */ new Set([...before.keys(), ...after.keys()])) {
    if (!collabEqual(before.get(id), after.get(id))) {
      changes.push({ id, expected: Object.hasOwn(base.rowVersions, id) ? base.rowVersions[id] : 0, row: after.get(id) || null });
    }
  }
  const data = { changes };
  if (!collabEqual(collabMeta(base.project), collabMeta(project))) {
    data.meta = { expected: base.metaVersion, value: collabMeta(project) };
  }
  const ids = project.rows.map((row) => row.id);
  if (!collabEqual(base.project.rows.map((row) => row.id), ids)) data.order = { expected: base.orderVersion, ids };
  return data;
}
function collabDirty(base, project) {
  const patch = collabPatch(base, project);
  return !!(patch.changes.length || patch.meta || patch.order);
}
function collabOrder(ids, rows) {
  const result = ids.filter((id) => rows.has(id));
  const present = new Set(result);
  for (const [id] of rows) if (!present.has(id)) result.push(id);
  return [...new Set(result)];
}
function collabMerge(base, local, remote) {
  const before = new Map(base.rows.map((row) => [row.id, row]));
  const mine = new Map(local.rows.map((row) => [row.id, row]));
  const theirs = new Map(remote.rows.map((row) => [row.id, row]));
  const merged = /* @__PURE__ */ new Map(), conflicts = [];
  for (const id of /* @__PURE__ */ new Set([...before.keys(), ...mine.keys(), ...theirs.keys()])) {
    const initial = before.get(id), localRow = mine.get(id), remoteRow = theirs.get(id);
    let value;
    if (collabEqual(localRow, initial)) value = remoteRow;
    else if (collabEqual(remoteRow, initial) || collabEqual(localRow, remoteRow)) value = localRow;
    else {
      value = localRow;
      conflicts.push({ kind: "row", id, local: localRow || null, remote: remoteRow || null });
    }
    if (value) merged.set(id, clone(value));
  }
  const initialMeta = collabMeta(base), localMeta = collabMeta(local), remoteMeta = collabMeta(remote);
  let meta;
  if (collabEqual(localMeta, initialMeta)) meta = remoteMeta;
  else if (collabEqual(remoteMeta, initialMeta) || collabEqual(localMeta, remoteMeta)) meta = localMeta;
  else {
    meta = localMeta;
    conflicts.push({ kind: "meta", local: localMeta, remote: remoteMeta });
  }
  const initialOrder = base.rows.map((row) => row.id), localOrder = local.rows.map((row) => row.id), remoteOrder = remote.rows.map((row) => row.id);
  let ids;
  if (collabEqual(localOrder, initialOrder)) ids = remoteOrder;
  else if (collabEqual(remoteOrder, initialOrder) || collabEqual(localOrder, remoteOrder)) ids = localOrder;
  else {
    ids = localOrder;
    conflicts.push({ kind: "order", local: localOrder, remote: remoteOrder });
  }
  return { project: { ...clone(meta), rows: collabOrder(ids, merged).map((id) => merged.get(id)) }, conflicts };
}
export {
  collabDirty,
  collabEqual,
  collabLeaderKey,
  collabMerge,
  collabMeta,
  collabOrder,
  collabParseLeaderKey,
  collabPatch
};
