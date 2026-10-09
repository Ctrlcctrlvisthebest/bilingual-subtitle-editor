export function initOfflinePractice(editor, practice) {
  const button = document.getElementById('offlinePractice');
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await editor.ready;
      const applied = await editor.importFile({name: '练习字幕.srt', text: async () => practice});
      if (applied) editor.notice('已打开 3 条练习字幕。原工程可在工程列表中切换；修改后可保存 JSON 或导出字幕。');
    } catch (error) {
      editor.notice('练习字幕打开失败：' + error.message);
    } finally {
      button.disabled = false;
    }
  });
}
