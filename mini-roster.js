const params = new URLSearchParams(window.location.search);
const list = document.querySelector('#student-list');
const taskSelect = document.querySelector('#task-select');
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('moabom-live') : null;
const ALL_TASKS = '__all__';
let state = { classrooms: [] };
let classId = params.get('classId') || '';
let courseId = params.get('courseId') || '';
let taskId = params.get('taskId') || '';

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function render() {
  const classroom = state.classrooms.find((room) => room.id === classId) || state.classrooms[0];
  const course = state.courses?.find((item) => item.id === courseId) || state.courses?.find((item) => item.classId === classroom?.id);
  if (!classroom) {
    document.querySelector('#class-name').textContent = '반 정보를 찾을 수 없어요';
    list.innerHTML = '<div class="mini-empty">교사 화면에서 반을 선택해 주세요.</div>';
    return;
  }
  classId = classroom.id;
  if (!course) {
    list.innerHTML = '<div class="mini-empty">과목 정보를 찾을 수 없어요.</div>';
    return;
  }
  courseId = course.id;
  if (taskId !== ALL_TASKS && !course.tasks.some((task) => task.id === taskId)) taskId = course.tasks[0]?.id || ALL_TASKS;
  const allTasksMode = taskId === ALL_TASKS;
  const task = course.tasks.find((entry) => entry.id === taskId);
  const completedAssignments = classroom.students.reduce((sum, student) => sum + course.tasks.filter((entry) => course.completions?.[student.id]?.[entry.id]).length, 0);
  const totalAssignments = classroom.students.length * course.tasks.length;
  const completed = task ? classroom.students.filter((student) => course.completions?.[student.id]?.[task.id]).length : completedAssignments;
  const denominator = allTasksMode ? totalAssignments : classroom.students.length;
  const percentage = denominator ? Math.round(completed / denominator * 100) : 0;
  document.querySelector('#class-name').textContent = classroom.name;
  document.querySelector('#student-count').textContent = `${classroom.students.length}명`;
  taskSelect.innerHTML = `<option value="${ALL_TASKS}" ${allTasksMode ? 'selected' : ''}>전체 과제 보기</option>${course.tasks.map((entry) => `<option value="${escapeHtml(entry.id)}" ${entry.id === taskId ? 'selected' : ''}>${escapeHtml(entry.title)}</option>`).join('')}`;
  taskSelect.disabled = false;
  document.querySelector('.mini-progress-top > span').textContent = allTasksMode ? '전체 과제 제출 현황' : '선택 과제 제출 현황';
  document.querySelector('#progress-count').textContent = allTasksMode ? `${completedAssignments} / ${totalAssignments}건` : `${completed} / ${classroom.students.length}명`;
  document.querySelector('#progress-bar').style.width = `${percentage}%`;
  document.querySelector('#progress-caption').textContent = allTasksMode
    ? `${percentage}% 전체 진행률 · ${course.tasks.length}개 과제`
    : task ? `${percentage}% 완료 · ${task.title}` : '과제를 추가하면 학생별 진행 상황을 볼 수 있어요.';
  list.innerHTML = classroom.students.length ? classroom.students.map((student, index) => {
    const completedTasks = course.tasks.filter((entry) => course.completions?.[student.id]?.[entry.id]).length;
    const category = course.tasks.length && completedTasks === course.tasks.length ? 'complete' : completedTasks ? 'partial' : 'none';
    const done = Boolean(task && course.completions?.[student.id]?.[task.id]);
    const label = allTasksMode ? (category === 'complete' ? '전체 완료' : category === 'partial' ? '일부 완료' : '미완료') : done ? '완료' : '진행 중';
    const marker = allTasksMode ? (category === 'complete' ? '✓' : category === 'partial' ? '◐' : '·') : done ? '✓' : '·';
    const rowClass = allTasksMode ? `progress-${category}` : done ? 'is-done' : 'is-pending';
    return `<article class="student-row ${rowClass}"><span class="student-index">${String(student.number || index + 1).padStart(2, '0')}</span><span class="student-name">${escapeHtml(student.name)}</span><span class="student-status"><i>${marker}</i>${label}</span></article>`;
  }).join('') : '<div class="mini-empty">아직 등록된 학생이 없어요.</div>';
}

taskSelect.addEventListener('change', () => {
  taskId = taskSelect.value;
  render();
  channel?.postMessage({ type: 'popup-selection', classId, courseId, taskId });
});
document.querySelector('#close-window').addEventListener('click', () => window.close());
channel?.addEventListener('message', (event) => {
  if (event.data.type !== 'selection') return;
  classId = event.data.classId;
  courseId = event.data.courseId;
  taskId = event.data.taskId;
  render();
});

const stateUrl = new URL('/api/state', window.location.origin);
if (courseId) stateUrl.searchParams.set('courseId', courseId);
fetch(stateUrl).then((response) => response.json()).then((next) => {
  state = next;
  render();
  const eventsUrl = new URL('/api/events', window.location.origin);
  if (courseId) eventsUrl.searchParams.set('courseId', courseId);
  const events = new EventSource(eventsUrl);
  events.onmessage = (event) => { state = JSON.parse(event.data); render(); };
});
