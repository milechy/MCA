const { test, expect } = require('@playwright/test');

const {
  backlogIdForTask, isHumanApproval, taskToBacklogItem,
  fetchAsanaTasks, syncTasksIntoBacklog
} = require('../../src/ralph/asana-bridge');

function fakeFetch(pages) {
  // pages: array of {data, next_page}. Returns them in order per call.
  let i = 0;
  return async () => ({ json: async () => pages[Math.min(i++, pages.length - 1)] });
}

test('backlogIdForTask is stable from the gid', () => {
  expect(backlogIdForTask({ gid: '123' })).toBe('ASANA-123');
});

test('isHumanApproval detects the marker in notes', () => {
  expect(isHumanApproval({ notes: 'step 4 ⚠️ HUMAN-APPROVAL-REQUIRED do x' })).toBe(true);
  expect(isHumanApproval({ notes: 'normal task' })).toBe(false);
});

test('taskToBacklogItem keeps notes + source link', () => {
  const item = taskToBacklogItem({ gid: '9', name: '[S1] Build thing', notes: 'spec here `src/x.js`', permalink_url: 'https://app.asana.com/x' });
  expect(item.id).toBe('ASANA-9');
  expect(item.title).toBe('[S1] Build thing');
  expect(item.body).toContain('spec here `src/x.js`');
  expect(item.body).toContain('synced from Asana');
});

test('fetchAsanaTasks paginates and collects tasks in order', async () => {
  const res = await fetchAsanaTasks({
    token: 'T', projectGid: 'P',
    fetchImpl: fakeFetch([
      { data: [{ gid: '1', name: 'a' }, { gid: '2', name: 'b' }], next_page: { offset: 'o2' } },
      { data: [{ gid: '3', name: 'c' }], next_page: null }
    ])
  });
  expect(res.ok).toBe(true);
  expect(res.tasks.map((t) => t.gid)).toEqual(['1', '2', '3']);
});

test('fetchAsanaTasks requires token + project', async () => {
  expect((await fetchAsanaTasks({ token: 'T' })).ok).toBe(false);
});

test('syncTasksIntoBacklog appends new incomplete tasks in priority order', () => {
  const tasks = [
    { gid: '1', name: 'High prio', notes: 'do `a.js`', completed: false },
    { gid: '2', name: 'Done one', completed: true },
    { gid: '3', name: 'Next prio', notes: 'do `b.js`', completed: false }
  ];
  const { backlog, added } = syncTasksIntoBacklog({ tasks, backlog: { items: [] } });
  expect(added).toBe(2);
  expect(backlog.items.map((i) => i.id)).toEqual(['ASANA-1', 'ASANA-3']); // completed skipped, order kept
});

test('syncTasksIntoBacklog skips HUMAN-APPROVAL-REQUIRED tasks', () => {
  const tasks = [
    { gid: '1', name: 'Risky', notes: 'deploy ⚠️ HUMAN-APPROVAL-REQUIRED', completed: false },
    { gid: '2', name: 'Safe', notes: 'add util', completed: false }
  ];
  const { backlog, added, skipped } = syncTasksIntoBacklog({ tasks, backlog: { items: [] } });
  expect(added).toBe(1);
  expect(backlog.items.map((i) => i.id)).toEqual(['ASANA-2']);
  expect(skipped).toEqual([{ id: 'ASANA-1', reason: 'human_approval_required' }]);
});

test('syncTasksIntoBacklog dedups against existing backlog ids', () => {
  const tasks = [{ gid: '1', name: 'Already', notes: 'x', completed: false }];
  const { added } = syncTasksIntoBacklog({ tasks, backlog: { items: [{ id: 'ASANA-1', title: 'Already', body: 'x' }] } });
  expect(added).toBe(0); // no duplicate
});
