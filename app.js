const app = document.querySelector('#app');
const toast = document.querySelector('#toast');
const ALL_TASKS = '__all__';
let state = { classrooms: [] };
const pageParams = new URLSearchParams(window.location.search);
let role = pageParams.get('role') === 'student' ? 'student' : 'teacher';
let view = 'current';
let selectedClassId = '';
let selectedCourseId = pageParams.get('course') || '';
let selectedTaskId = '';
let selectedStudent = null;
let toastTimer;
let teacherProfile = null;
let eventStream = null;
let authMode = 'login';
const boardChannel = 'BroadcastChannel' in window ? new BroadcastChannel('moabom-live') : null;

const icons = {
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 4v16M15 4v16M3 10h18M3 15h18"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
  people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="9" cy="8" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.3a3 3 0 0 1 0 5.8M17 14a5 5 0 0 1 3.5 4.8"/></svg>',
  seats: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 4h6v5H4zM14 4h6v5h-6zM4 14h6v5H4zM14 14h6v5h-6z"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 19V5M4 19h17M8 15l4-4 3 2 5-7"/><path d="M17 6h3v3"/></svg>'
};

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function currentClass() {
  const course = currentCourse();
  return state.classrooms.find((item) => item.id === selectedClassId) || state.classrooms.find((item) => item.id === course?.classId) || state.classrooms[0];
}

function currentCourse() {
  return state.courses?.find((item) => item.id === selectedCourseId) || state.courses?.find((item) => item.classId === selectedClassId) || (!selectedClassId ? state.courses?.[0] : undefined);
}

function courseClassroom(course = currentCourse()) {
  const classroom = state.classrooms.find((item) => item.id === selectedClassId) || state.classrooms.find((item) => item.id === course?.classId);
  return classroom ? { ...classroom, tasks: course?.tasks || [], completions: course?.completions || {} } : undefined;
}

function isDone(classroom, studentId, taskId) {
  return Boolean(classroom.completions?.[studentId]?.[taskId]);
}

function countDone(classroom, student) {
  return classroom.tasks.filter((task) => isDone(classroom, student.id, task.id)).length;
}

function progressCategory(classroom, student) {
  const completed = countDone(classroom, student);
  if (classroom.tasks.length > 0 && completed === classroom.tasks.length) return 'complete';
  return completed > 0 ? 'partial' : 'none';
}

function progressLabel(category) {
  return category === 'complete' ? '전체 완료' : category === 'partial' ? '일부 완료' : '미완료';
}

function progressSymbol(category) {
  return category === 'complete' ? '✓' : category === 'partial' ? '◐' : '·';
}

function notify(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

async function act(action, successMessage) {
  try {
    const response = await fetch(apiUrl('/api/action'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '요청을 처리하지 못했습니다.');
    state = result;
    if (action.type === 'create-class') {
      selectedClassId = result.classrooms.at(-1)?.id || selectedClassId;
      selectedCourseId = result.courses.at(-1)?.id || selectedCourseId;
      selectedTaskId = '';
    }
    if (action.type === 'create-course') {
      selectedCourseId = result.courses.at(-1)?.id || selectedCourseId;
      selectedClassId = result.courses.at(-1)?.classId || selectedClassId;
      selectedTaskId = '';
    }
    if (action.type === 'delete-class') {
      selectedClassId = result.classrooms[0]?.id || '';
      selectedCourseId = result.courses.find((course) => course.classId === selectedClassId)?.id || '';
      selectedTaskId = '';
      selectedStudent = null;
    }
    if (action.type === 'delete-course') {
      selectedCourseId = result.courses.find((course) => course.classId === action.classId)?.id || '';
      selectedTaskId = '';
    }
    if (action.type === 'add-task') selectedTaskId = result.courses.find((course) => course.id === action.courseId)?.tasks.at(-1)?.id || selectedTaskId;
    render();
    broadcastSelection();
    if (successMessage) notify(successMessage);
    return result;
  } catch (error) {
    notify(error.message, true);
    return null;
  }
}

function updateHeader() {
  document.querySelectorAll('.role-button').forEach((button) => {
    const active = button.dataset.role === role;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function classSelect() {
  return `<label class="select-wrap toolbar-select"><span>학급</span><select id="class-select" aria-label="학급 선택">${state.classrooms.map((room) => `<option value="${escapeHtml(room.id)}" ${room.id === selectedClassId ? 'selected' : ''}>${escapeHtml(room.name)}</option>`).join('')}</select></label>`;
}

function courseSelect(classroom) {
  const courses = (state.courses || []).filter((course) => course.classId === classroom.id);
  return `<label class="select-wrap toolbar-select"><span>과목</span><select id="course-select" aria-label="과목 선택" ${courses.length ? '' : 'disabled'}>${courses.map((course) => `<option value="${escapeHtml(course.id)}" ${course.id === selectedCourseId ? 'selected' : ''}>${escapeHtml(course.name)}</option>`).join('') || '<option value="">과목 없음</option>'}</select></label>`;
}

function taskSelect(classroom) {
  return `<label class="select-wrap toolbar-select active-task-wrap"><span>현재 확인 과제</span><select id="active-task-select" aria-label="현재 확인할 과제 선택"><option value="${ALL_TASKS}" ${selectedTaskId === ALL_TASKS ? 'selected' : ''}>전체 과제 보기</option>${classroom.tasks.map((task) => `<option value="${escapeHtml(task.id)}" ${task.id === selectedTaskId ? 'selected' : ''}>${escapeHtml(task.title)}</option>`).join('')}</select></label>`;
}

function classCodeControl(classroom) {
  return `<div class="toolbar-code"><span>반 코드</span><code class="class-code">${escapeHtml(classroom.joinCode)}</code></div>`;
}

function broadcastSelection() {
  boardChannel?.postMessage({ type: 'selection', classId: selectedClassId, courseId: selectedCourseId, taskId: selectedTaskId });
}

function studentCourseUrl() {
  const url = new URL('/', window.location.origin);
  url.searchParams.set('course', currentCourse().studentToken);
  url.searchParams.set('role', 'student');
  return url.href;
}

function apiUrl(path) {
  const url = new URL(path, window.location.origin);
  if (role === 'student' && pageParams.has('course')) url.searchParams.set('studentToken', pageParams.get('course'));
  return url;
}

function printReport(classroom, course) {
  return `<section id="print-report"><header><p>MOABOM CLASS PROGRESS REPORT</p><h1>${escapeHtml(classroom.name)} · ${escapeHtml(course.name)}</h1><span>출력일 ${new Date().toLocaleDateString('ko-KR')} · 학생 ${classroom.students.length}명 · 과제 ${course.tasks.length}개</span></header><table><thead><tr><th>번호</th><th>학생 이름</th>${course.tasks.map((task) => `<th>${escapeHtml(task.title)}</th>`).join('')}<th>전체 진행</th><th>완료 과제</th></tr></thead><tbody>${classroom.students.map((student, index) => `<tr class="progress-${progressCategory(classroom, student)}"><td>${escapeHtml(student.number || index + 1)}</td><td>${escapeHtml(student.name)}</td>${course.tasks.map((task) => `<td class="${isDone(classroom, student.id, task.id) ? 'print-done' : 'print-pending'}">${isDone(classroom, student.id, task.id) ? '✓ 완료' : '진행 중'}</td>`).join('')}<td>${progressLabel(progressCategory(classroom, student))}</td><td>${countDone(classroom, student)} / ${course.tasks.length}</td></tr>`).join('')}</tbody></table></section>`;
}

function renderNoCourse(classroom) {
  app.innerHTML = `<section class="page-heading"><div><p class="eyebrow">CLASSROOM / ${escapeHtml(classroom.name)}</p><h1>과목을 선택해 주세요</h1><p class="heading-note">이 학급에는 아직 과목이 없습니다.</p></div><div class="heading-controls">${courseSelect(classroom)}${classSelect()}${classCodeControl(classroom)}<button class="button secondary" id="manage-classroom-button" type="button">설정</button><button class="button" id="add-course-button" type="button">${icons.plus} 과목 추가</button><button class="button secondary" id="add-class-button" type="button">${icons.plus} 반 추가</button></div></section><section class="view-panel no-course-panel"><div><span class="view-icon">${icons.chart}</span><h2>과목을 추가하면 이 학급의 진행 현황을 볼 수 있어요.</h2><button class="button" id="add-first-course" type="button">${icons.plus} 첫 과목 만들기</button></div></section><section class="roster-tools"><div class="roster-upload"><div><strong>모든 학급 학생 명단</strong><span>엑셀은 학급별 시트에 번호·이름을, CSV는 학급·번호·이름 열을 작성해 한 번 올려요</span></div><div class="roster-upload-actions"><a class="button secondary small" href="/api/templates/class-roster" download>모든 학급 양식</a><label class="button secondary small" for="roster-file">엑셀 업로드</label><input id="roster-file" class="visually-hidden" type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"></div></div><div class="add-student-inline"><label for="add-student-name">학생 한 명 추가</label><input id="add-student-name" placeholder="학생 이름" maxlength="30"><button class="button secondary small" id="add-student-button" type="button">${icons.plus} 추가</button><button class="button secondary small" id="manage-students-button" type="button">학생 관리</button></div></section>`;
  document.querySelector('#class-select')?.addEventListener('change', (event) => {
    selectedClassId = event.target.value;
    selectedCourseId = state.courses.find((course) => course.classId === selectedClassId)?.id || '';
    render();
  });
  document.querySelector('#manage-classroom-button')?.addEventListener('click', () => showClassroomSettings(classroom, null));
  document.querySelector('#add-course-button')?.addEventListener('click', showCourseForm);
  document.querySelector('#add-class-button')?.addEventListener('click', showClassForm);
  document.querySelector('#add-first-course')?.addEventListener('click', showCourseForm);
  document.querySelector('#roster-file')?.addEventListener('change', (event) => {
    if (event.target.files[0]) importRoster(event.target.files[0], classroom.id);
    event.target.value = '';
  });
  document.querySelector('#add-student-button')?.addEventListener('click', addStudentFromInput);
  document.querySelector('#manage-students-button')?.addEventListener('click', () => showStudentManager(classroom));
  document.querySelector('#add-student-name')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') addStudentFromInput(); });
}

function renderTeacher() {
  const course = currentCourse();
  const baseClassroom = currentClass();
  const classroom = courseClassroom(course);
  if (!classroom) {
    app.innerHTML = `<section class="join-panel"><p class="eyebrow">CLASSROOM SETUP</p><h2>첫 번째 반을 만들어 보세요</h2><p>반 코드는 직접 지정하거나 비워 두어 무작위로 만들 수 있어요.</p><form class="form-grid" id="create-class-form"><div class="field"><label for="new-class-name">학급 이름</label><input id="new-class-name" name="name" required placeholder="예: 6학년 2반"></div><div class="field"><label for="new-class-code">반 코드 (선택)</label><input id="new-class-code" name="joinCode" pattern="[A-Za-z0-9-]{3,12}" maxlength="12" placeholder="비워 두면 자동 생성"><small>영문, 숫자, 하이픈 3~12자</small></div><button class="button" type="submit">반 만들기</button></form></section><section class="roster-tools"><div class="roster-upload"><div><strong>여러 학급 명단을 엑셀로 한 번에 시작하기</strong><span>양식의 학급·번호·이름을 작성하면, 등록되지 않은 학급도 자동으로 만들어져요.</span></div><div class="roster-upload-actions"><a class="button secondary small" href="/api/templates/class-roster" download>모든 학급 양식</a><label class="button secondary small" for="roster-file">엑셀 업로드</label><input id="roster-file" class="visually-hidden" type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"></div></div></section>`;
    document.querySelector('#create-class-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      act({ type: 'create-class', name: values.get('name'), joinCode: values.get('joinCode') }, '새 반을 만들었어요.');
    });
    document.querySelector('#roster-file').addEventListener('change', (event) => {
      if (event.target.files[0]) importRoster(event.target.files[0], '');
      event.target.value = '';
    });
    return;
  }
  if (!course) return renderNoCourse(baseClassroom);

  if (selectedTaskId !== ALL_TASKS && !classroom.tasks.some((task) => task.id === selectedTaskId)) selectedTaskId = classroom.tasks[0]?.id || '';

  const activeTask = classroom.tasks.find((task) => task.id === selectedTaskId);
  const allTasksMode = selectedTaskId === ALL_TASKS;
  const completedAssignments = classroom.students.reduce((sum, student) => sum + countDone(classroom, student), 0);
  const totalAssignments = classroom.students.length * classroom.tasks.length;
  const activeDone = activeTask ? classroom.students.filter((student) => isDone(classroom, student.id, activeTask.id)).length : 0;
  const percent = allTasksMode
    ? (totalAssignments ? Math.round(completedAssignments / totalAssignments * 100) : 0)
    : (classroom.students.length ? Math.round(activeDone / classroom.students.length * 100) : 0);
  const fullyDoneStudents = classroom.students.filter((student) => progressCategory(classroom, student) === 'complete').length;
  const partlyDoneStudents = classroom.students.filter((student) => progressCategory(classroom, student) === 'partial').length;
  const notStartedStudents = classroom.students.filter((student) => progressCategory(classroom, student) === 'none').length;
  const incomplete = classroom.students.filter((student) => countDone(classroom, student) < classroom.tasks.length);
  const viewLabels = [
    ['current', '선택 과제'], ['table', '전체 과제표'], ['compact', '좁은 명렬표'], ['seats', '자리배치표'], ['incomplete', '미완료 학생'], ['summary', '진행 요약']
  ];
  const viewTitles = { current: '선택한 과제 진행 현황', table: '학생별 전체 과제 현황', compact: '한쪽에 띄우는 명렬표', seats: '우리 반 자리배치', incomplete: '아직 진행 중인 학생', summary: '과제별 진행 요약' };
  const viewDescriptions = { current: '선택한 과제 하나만 집중해서 확인해요.', table: '학생마다 모든 과제의 상태를 확인해요.', compact: '화면 옆에 작게 띄워도 잘 보이도록 정리했어요.', seats: '이름표를 끌어 옮기면 좌석이 저장돼요.', incomplete: '남은 과제가 있는 학생을 모아 보여줘요.', summary: '과제별 완료 비율을 비교해요.' };
  const viewIcons = { current: icons.chart, table: icons.grid, compact: icons.people, seats: icons.seats, incomplete: icons.people, summary: icons.chart };
  const qrUrl = `/api/course-qr?courseId=${encodeURIComponent(course.id)}&origin=${encodeURIComponent(window.location.origin)}`;

  app.innerHTML = `
    <section class="page-heading">
      <div><p class="eyebrow">TEACHER BOARD / LIVE</p><h1>수업 진행 현황</h1><p class="heading-note">학생들의 과제 진행을 한눈에 살펴보세요.</p></div>
      <div class="heading-controls">${courseSelect(baseClassroom)}${classSelect()}${taskSelect(classroom)}${classCodeControl(classroom)}${pageParams.has('course') ? '' : `<button class="button secondary" id="manage-classroom-button" type="button">설정</button><button class="button secondary" id="add-course-button" type="button">${icons.plus} 과목 추가</button><button class="button secondary" id="add-class-button" type="button">${icons.plus} 반 추가</button>`}</div>
    </section>
    <section class="course-link-panel"><div><p class="section-kicker">${escapeHtml(course.name)} · ${escapeHtml(classroom.name)}</p><h2>학생에게 과제 링크 보내기</h2><span class="course-link-caption">교사는 이 앱에서 과목과 학급을 선택하고, 학생에게는 아래 링크나 QR을 보내주세요.</span></div><div class="course-link-item"><span>학생용 링크</span><code>${escapeHtml(studentCourseUrl())}</code><button class="button secondary small" id="copy-student-link" type="button">링크 복사</button><a class="button secondary small" href="${escapeHtml(studentCourseUrl())}" target="_blank" rel="noopener">미리보기</a></div><div class="course-qr"><button class="course-qr-trigger" id="open-large-qr" type="button" aria-label="학생 접속 QR 크게 보기"><img id="course-qr-image" src="${qrUrl}" alt="${escapeHtml(course.name)} 학생 접속 QR 코드"></button><a class="button secondary small" href="${qrUrl}&download=1" download="moabom-student-qr.svg">QR 저장</a></div><dialog class="qr-zoom-dialog" id="qr-zoom-dialog" aria-labelledby="qr-zoom-title"><div class="qr-zoom-heading"><div><p class="section-kicker">${escapeHtml(classroom.name)} · ${escapeHtml(course.name)}</p><h2 id="qr-zoom-title">학생 접속 QR 코드</h2></div><button class="qr-zoom-close" id="close-large-qr" type="button" aria-label="QR 확대 닫기">×</button></div><img class="qr-zoom-image" src="${qrUrl}" alt="스마트폰으로 스캔할 학생 접속 QR 코드"><p>학생이 휴대전화 카메라로 스캔하면 이 과목에 바로 접속합니다.</p></dialog></section>
    <section class="overview-grid" aria-label="반 진행 요약">
      <article class="overview-card primary"><span class="overview-label">${allTasksMode ? '전체 과제 진행률' : '선택 과제 진행률'}</span><div class="overview-value">${percent}<small>%</small></div><div class="overview-caption">${allTasksMode ? `${completedAssignments} / ${totalAssignments}건 제출 완료` : `${activeTask ? escapeHtml(activeTask.title) : '과제를 추가해 주세요'} · ${activeDone}명 완료`}</div><span class="overview-watermark" aria-hidden="true"></span></article>
      <article class="overview-card"><span class="overview-label">참여 학생</span><div class="overview-value">${classroom.students.length}<small>명</small></div><div class="overview-caption">${classroom.name} 등록 인원</div></article>
      <article class="overview-card"><span class="overview-label">진행 중인 과제</span><div class="overview-value">${classroom.tasks.length}<small>개</small></div><div class="overview-caption">과제 안내 ${classroom.tasks.filter((task) => task.instructions).length}개 포함</div></article>
      <article class="overview-card"><span class="overview-label">${allTasksMode ? '전체 완료 학생' : '선택 과제 완료'}</span><div class="overview-value">${allTasksMode ? fullyDoneStudents : activeDone}<small> / ${classroom.students.length}명</small></div><div class="overview-caption">${allTasksMode ? `${partlyDoneStudents}명 일부 완료 · ${notStartedStudents}명 미완료` : `${classroom.students.length - activeDone}명 진행 중`}</div></article>
    </section>
    <section class="view-panel">
        <div class="panel-topline"><div class="panel-title"><span class="view-icon">${viewIcons[view]}</span><div><h2>${view === 'current' && allTasksMode ? '전체 과제 진행 현황' : viewTitles[view]}</h2><p>${view === 'current' && allTasksMode ? '과목의 모든 과제 제출 건수를 합산해 보여줘요.' : viewDescriptions[view]}</p></div></div>
        <div class="view-switcher" role="tablist" aria-label="전자칠판 보기 선택">${viewLabels.map(([key, label]) => `<button class="view-tab ${view === key ? 'active' : ''}" role="tab" aria-selected="${view === key}" data-view="${key}">${label}</button>`).join('')}</div>
      </div>
      <div class="panel-content">${renderView(classroom, incomplete)}</div>
      <div class="panel-foot"><span>마지막 반영: 방금 전 · 여러 기기에서 자동으로 동기화됩니다</span><div class="panel-foot-actions"><button class="button secondary small" id="open-mini-roster" type="button">${icons.people} 미니명렬표 팝업</button><button class="button secondary small" id="export-course-csv" type="button">CSV 파일 저장</button><button class="button secondary small" id="print-course-report" type="button">인쇄 / PDF</button><button class="button secondary small" id="copy-tasks-button" type="button">과제 복사</button><button class="button secondary small" id="add-task-button" type="button">${icons.plus} 과제 추가</button></div></div>
    </section>
    <section class="roster-tools"><div class="roster-upload"><div><strong>모든 학급 학생 명단</strong><span>엑셀은 학급별 시트에 번호·이름을 작성하세요. 새 시트 이름은 새 학급으로 만들어집니다. CSV는 학급·번호·이름 열을 사용해요.</span></div><div class="roster-upload-actions"><a class="button secondary small" href="/api/templates/class-roster" download>모든 학급 양식</a><label class="button secondary small" for="roster-file">엑셀 업로드</label><input id="roster-file" class="visually-hidden" type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"></div></div><div class="add-student-inline"><label for="add-student-name">학생 한 명 추가</label><input id="add-student-name" placeholder="학생 이름" maxlength="30"><button class="button secondary small" id="add-student-button" type="button">${icons.plus} 추가</button><button class="button secondary small" id="manage-students-button" type="button">학생 관리</button></div></section>${printReport(classroom, course)}`;

  document.querySelector('#class-select')?.addEventListener('change', (event) => {
    selectedClassId = event.target.value;
    const firstCourse = state.courses.find((item) => item.classId === selectedClassId);
    selectedCourseId = firstCourse?.id || '';
    selectedTaskId = '';
    render();
    broadcastSelection();
  });
  document.querySelector('#course-select')?.addEventListener('change', (event) => {
    selectedCourseId = event.target.value;
    selectedClassId = currentCourse()?.classId || selectedClassId;
    selectedTaskId = '';
    render();
    broadcastSelection();
  });
  document.querySelector('#active-task-select')?.addEventListener('change', (event) => {
    selectedTaskId = event.target.value;
    render();
    broadcastSelection();
  });
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => { view = button.dataset.view; render(); }));
  document.querySelector('#add-class-button')?.addEventListener('click', showClassForm);
  document.querySelector('#add-course-button')?.addEventListener('click', showCourseForm);
  document.querySelector('#manage-classroom-button')?.addEventListener('click', () => showClassroomSettings(classroom, course));
  document.querySelector('#add-task-button')?.addEventListener('click', showTaskForm);
  document.querySelector('#open-mini-roster')?.addEventListener('click', openMiniRoster);
  document.querySelector('#export-course-csv')?.addEventListener('click', () => exportCourseCsv(classroom, course));
  document.querySelector('#print-course-report')?.addEventListener('click', () => window.print());
  document.querySelector('#copy-tasks-button')?.addEventListener('click', () => showCopyTasksDialog(classroom, course));
  document.querySelector('#copy-student-link')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(studentCourseUrl());
      notify('학생용 과목 링크를 복사했어요.');
    } catch {
      notify('링크 복사를 사용할 수 없어요. 링크를 열어 주소를 복사해 주세요.', true);
    }
  });
  const qrDialog = document.querySelector('#qr-zoom-dialog');
  document.querySelector('#open-large-qr')?.addEventListener('click', () => qrDialog.showModal());
  document.querySelector('#close-large-qr')?.addEventListener('click', () => qrDialog.close());
  qrDialog?.addEventListener('click', (event) => { if (event.target === qrDialog) qrDialog.close(); });
  document.querySelector('#roster-file')?.addEventListener('change', (event) => {
    if (event.target.files[0]) importRoster(event.target.files[0], classroom.id);
    event.target.value = '';
  });
  document.querySelector('#add-student-button')?.addEventListener('click', addStudentFromInput);
  document.querySelector('#manage-students-button')?.addEventListener('click', () => showStudentManager(classroom));
  document.querySelector('#add-student-name')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') addStudentFromInput(); });
  if (view === 'seats') bindSeatEditor(classroom);
}

function renderAllTasksProgress(classroom) {
  const totalAssignments = classroom.students.length * classroom.tasks.length;
  const completedAssignments = classroom.students.reduce((sum, student) => sum + countDone(classroom, student), 0);
  const percent = totalAssignments ? Math.round(completedAssignments / totalAssignments * 100) : 0;
  const categories = [
    ['complete', '전체 완료'],
    ['partial', '일부 완료'],
    ['none', '미완료']
  ];
  return `<div class="all-progress-view"><section class="all-progress-overview"><div class="all-progress-heading"><div><span class="section-kicker">${escapeHtml(classroom.name)} / ALL TASKS</span><h3>전체 과제 진행률</h3><p>${classroom.tasks.length}개 과제 · ${classroom.students.length}명</p></div><div class="all-progress-score"><strong>${percent}<small>%</small></strong><span>전체 제출률</span></div></div><div class="all-progress-track" role="progressbar" aria-label="전체 과제 제출률" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"><i style="width:${percent}%"></i></div><div class="all-progress-caption">${completedAssignments} / ${totalAssignments}건 제출 완료</div></section><div class="all-progress-groups">${categories.map(([category, label]) => {
    const students = classroom.students.filter((student) => progressCategory(classroom, student) === category);
    return `<section class="all-progress-group progress-${category}"><h3><span class="progress-marker progress-${category}">${progressSymbol(category)}</span>${label}<small>${students.length}명</small></h3><div>${students.map((student, index) => `<div class="all-progress-student"><span class="student-number">${String(student.number || classroom.students.indexOf(student) + 1).padStart(2, '0')}</span><strong>${escapeHtml(student.name)}</strong><span>${countDone(classroom, student)} / ${classroom.tasks.length}</span></div>`).join('') || '<p class="all-progress-empty">해당 학생이 없습니다.</p>'}</div></section>`;
  }).join('')}</div></div>`;
}

function renderView(classroom, incomplete) {
  if (view === 'current') {
    if (selectedTaskId === ALL_TASKS) return renderAllTasksProgress(classroom);
    const task = classroom.tasks.find((entry) => entry.id === selectedTaskId);
    if (!task) return '<div class="empty-state">먼저 과제를 추가하면 선택 과제의 진행률을 확인할 수 있어요.</div>';
    const doneStudents = classroom.students.filter((student) => isDone(classroom, student.id, task.id));
    const pendingStudents = classroom.students.filter((student) => !isDone(classroom, student.id, task.id));
    const renderStudents = (students, done) => students.map((student) => {
      const category = progressCategory(classroom, student);
      return `<div class="task-status-card progress-${category} ${done ? 'selected-task-done' : ''}"><span class="task-status-icon" aria-hidden="true">${done ? '✓' : '·'}</span><span class="student-number">${String(student.number || classroom.students.indexOf(student) + 1).padStart(2, '0')}</span><strong>${escapeHtml(student.name)}</strong><span class="task-status-label">${progressLabel(category)}</span></div>`;
    }).join('') || `<div class="task-status-empty">${done ? '아직 완료한 학생이 없어요.' : '모든 학생이 이 과제를 완료했어요.'}</div>`;
    return `<div class="current-task-summary"><div><span class="section-kicker">현재 선택 과제</span><h3>${escapeHtml(task.title)}</h3>${task.instructions ? `<p>${escapeHtml(task.instructions)}</p>` : ''}</div><div class="current-task-score"><strong>${doneStudents.length}<small> / ${classroom.students.length}</small></strong><span>학생 완료</span></div></div><div class="task-status-columns"><section class="task-status-group"><h3><span class="done-key">✓</span> 완료 <small>${doneStudents.length}명</small></h3><div class="task-status-list">${renderStudents(doneStudents, true)}</div></section><section class="task-status-group"><h3><span class="pending-key">·</span> 진행 중 <small>${pendingStudents.length}명</small></h3><div class="task-status-list">${renderStudents(pendingStudents, false)}</div></section></div>`;
  }
  if (view === 'table') {
    if (!classroom.students.length) return '<div class="empty-state">아직 등록된 학생이 없어요. 아래에서 학생 이름을 추가해 주세요.</div>';
    if (!classroom.tasks.length) return '<div class="empty-state">과제를 추가하면 학생별 진행 현황이 여기에 표시돼요.</div>';
    return `<div class="table-scroll"><table class="progress-table"><thead><tr><th scope="col">학생 / 진행 과제</th>${classroom.tasks.map((task) => `<th scope="col">${escapeHtml(task.title)}</th>`).join('')}<th scope="col">완료 수</th></tr></thead><tbody>${classroom.students.map((student, index) => `<tr class="table-student-row progress-${progressCategory(classroom, student)}"><td><span class="student-name-cell"><span class="student-number">${String(student.number || index + 1).padStart(2, '0')}</span>${escapeHtml(student.name)}</span></td>${classroom.tasks.map((task) => `<td><span class="status-pill ${isDone(classroom, student.id, task.id) ? 'done' : 'pending'}">${isDone(classroom, student.id, task.id) ? '✓ 완료' : '진행 중'}</span></td>`).join('')}<td class="completion-count">${countDone(classroom, student)} / ${classroom.tasks.length}</td></tr>`).join('')}</tbody></table></div>`;
  }
  if (view === 'compact') {
    return `<div class="compact-view"><div class="compact-main"><h3>우리 반 진행 요약</h3><p>학생별로 완료한 과제 수를 빠르게 확인해요.</p><div class="compact-list">${classroom.students.map((student, index) => {
      const category = progressCategory(classroom, student);
      return `<div class="compact-row progress-${category}"><span class="compact-person"><span class="student-number">${String(student.number || index + 1).padStart(2, '0')}</span>${escapeHtml(student.name)}<span class="progress-marker progress-${category}" aria-label="${progressLabel(category)}">${progressSymbol(category)}</span></span><span class="compact-count">${progressLabel(category)} · ${countDone(classroom, student)} / ${classroom.tasks.length}</span></div>`;
    }).join('') || '<div class="empty-state">아직 학생이 없어요.</div>'}</div></div><aside class="side-roster"><div class="side-roster-head"><h3>미니 명렬표</h3><span>${classroom.students.length}명</span></div><div class="side-roster-list">${classroom.students.map((student, index) => {
      const category = progressCategory(classroom, student);
      return `<div class="side-roster-item progress-${category}"><span><span class="roster-mini-number">${String(student.number || index + 1).padStart(2, '0')}</span>${escapeHtml(student.name)}<i class="progress-marker progress-${category}" aria-label="${progressLabel(category)}">${progressSymbol(category)}</i></span><span class="roster-progress" aria-label="진행률 ${classroom.tasks.length ? Math.round(countDone(classroom, student) / classroom.tasks.length * 100) : 0}%"><i style="width:${classroom.tasks.length ? countDone(classroom, student) / classroom.tasks.length * 100 : 0}%"></i></span></div>`;
    }).join('')}</div></aside></div>`;
  }
  if (view === 'seats') {
    const cells = classroom.rows * classroom.cols;
    return `<div class="seat-stage"><div class="seat-tools"><label for="seat-rows">행</label><input id="seat-rows" type="number" min="1" max="10" value="${classroom.rows}"><label for="seat-cols">열</label><input id="seat-cols" type="number" min="1" max="10" value="${classroom.cols}"><button class="button secondary small" id="save-seats" type="button">배치 저장</button><span class="section-kicker">이름표를 끌어 원하는 자리로 옮기세요</span></div><div class="seat-board-label">칠 판</div><div class="seat-grid" style="grid-template-columns:repeat(${classroom.cols}, minmax(74px, 1fr))">${Array.from({ length: cells }, (_, seat) => {
      const student = classroom.students.find((entry) => entry.seat === seat);
      const category = student ? progressCategory(classroom, student) : 'none';
      return `<div class="seat" data-seat="${seat}">${student ? `<div class="seat-card progress-${category}" draggable="true" tabindex="0" data-student="${escapeHtml(student.id)}"><span class="seat-avatar">${escapeHtml(String(student.number || classroom.students.indexOf(student) + 1))}</span><span class="seat-info"><strong>${escapeHtml(student.name)}</strong><span>${progressLabel(category)} · ${countDone(classroom, student)} / ${classroom.tasks.length} 완료</span></span><span class="seat-status-mark progress-${category}" aria-label="${progressLabel(category)}">${progressSymbol(category)}</span></div>` : '<span class="empty-seat">빈 자리</span>'}</div>`;
    }).join('')}</div></div>`;
  }
  if (view === 'incomplete') {
    const studentsWithWork = incomplete.filter((student) => classroom.tasks.length > countDone(classroom, student));
    if (!studentsWithWork.length) return '<div class="empty-state">모든 학생이 과제를 완료했어요. 정말 멋져요!</div>';
    return `<div class="incomplete-list">${studentsWithWork.map((student, index) => {
      const pending = classroom.tasks.filter((task) => !isDone(classroom, student.id, task.id));
      const category = progressCategory(classroom, student);
      return `<div class="incomplete-row progress-${category}"><span class="student-name-cell"><span class="student-number">${String(student.number || index + 1).padStart(2, '0')}</span><span class="progress-marker progress-${category}" aria-label="${progressLabel(category)}">${progressSymbol(category)}</span>${escapeHtml(student.name)}</span><span class="incomplete-tasks">${pending.map((task) => `<span class="task-chip">${escapeHtml(task.title)}</span>`).join('')}</span><span class="incomplete-total">${progressLabel(category)} · ${pending.length}개 남음</span></div>`;
    }).join('')}</div>`;
  }
  return `<div class="summary-list">${classroom.tasks.map((task) => {
    const done = classroom.students.filter((student) => isDone(classroom, student.id, task.id)).length;
    const rate = classroom.students.length ? Math.round(done / classroom.students.length * 100) : 0;
    return `<div class="summary-row"><div><div class="summary-task-name">${escapeHtml(task.title)}</div><div class="summary-task-note">${task.instructions ? '안내 포함' : '안내 없음'}</div></div><div class="progress-track" role="progressbar" aria-label="${escapeHtml(task.title)} 완료율" aria-valuenow="${rate}" aria-valuemin="0" aria-valuemax="100"><i style="width:${rate}%"></i></div><span class="summary-percent">${rate}%</span><span class="summary-fraction">${done} / ${classroom.students.length}명</span></div>`;
  }).join('') || '<div class="empty-state">과제를 추가하면 과제별 진행률을 볼 수 있어요.</div>'}</div>`;
}

function bindSeatEditor(classroom) {
  document.querySelector('#save-seats')?.addEventListener('click', () => act({
    type: 'configure-seats', classId: classroom.id,
    rows: document.querySelector('#seat-rows').value, cols: document.querySelector('#seat-cols').value
  }, '좌석 크기를 저장했어요.'));
  let draggedId = '';
  document.querySelectorAll('.seat-card').forEach((card) => {
    card.addEventListener('dragstart', () => { draggedId = card.dataset.student; });
    card.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      const nextSeat = (Number(card.closest('.seat').dataset.seat) + 1) % (classroom.rows * classroom.cols);
      act({ type: 'move-seat', classId: classroom.id, studentId: card.dataset.student, seat: nextSeat }, '학생 좌석을 옮겼어요.');
    });
  });
  document.querySelectorAll('.seat').forEach((seat) => {
    seat.addEventListener('dragover', (event) => { event.preventDefault(); seat.classList.add('drag-over'); });
    seat.addEventListener('dragleave', () => seat.classList.remove('drag-over'));
    seat.addEventListener('drop', (event) => {
      event.preventDefault();
      seat.classList.remove('drag-over');
      if (draggedId) act({ type: 'move-seat', classId: classroom.id, studentId: draggedId, seat: seat.dataset.seat }, '학생 좌석을 옮겼어요.');
    });
  });
}

function showClassForm() {
  document.querySelector('#create-class-dialog')?.remove();
  document.body.insertAdjacentHTML('beforeend', `<dialog class="app-dialog" id="create-class-dialog"><form id="create-class-dialog-form"><p class="eyebrow">NEW CLASSROOM</p><h2>새 학급 만들기</h2><p class="dialog-note">반 코드는 직접 정하거나 비워 두어 무작위로 생성할 수 있어요.</p><div class="form-grid"><div class="field"><label for="dialog-class-name">학급 이름</label><input id="dialog-class-name" name="name" required placeholder="예: 6학년 2반"></div><div class="field"><label for="dialog-class-code">반 코드 (선택)</label><input id="dialog-class-code" name="joinCode" pattern="[A-Za-z0-9-]{3,12}" maxlength="12" placeholder="예: 6-2-A"><small>영문, 숫자, 하이픈 3~12자. 비우면 자동 생성돼요.</small></div></div><div class="dialog-actions"><button class="button secondary" id="cancel-class-create" type="button">취소</button><button class="button" type="submit">반 만들기</button></div></form></dialog>`);
  const dialog = document.querySelector('#create-class-dialog');
  dialog.showModal();
  document.querySelector('#cancel-class-create').addEventListener('click', () => { dialog.close(); dialog.remove(); });
  document.querySelector('#create-class-dialog-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const result = await act({ type: 'create-class', name: values.get('name'), joinCode: values.get('joinCode') }, '새 반을 만들었어요.');
    if (result) { dialog.close(); dialog.remove(); }
  });
}

function showClassroomSettings(classroom, course) {
  document.querySelector('#classroom-settings-dialog')?.remove();
  const isLastCourse = state.courses.filter((item) => item.classId === classroom.id).length <= 1;
  const courseSection = course
    ? `<section class="settings-section"><h3>${escapeHtml(course.name)} 과목</h3><p>과목을 삭제하면 과제와 완료 기록도 함께 영구 삭제됩니다.</p>${isLastCourse ? '<p class="settings-hint">마지막 과목을 삭제해도 학급과 학생 명단은 남아요. 나중에 새 과목을 만들 수 있어요.</p>' : ''}<button class="button danger-button" id="delete-course-button" type="button">이 과목 삭제</button></section>`
    : '<section class="settings-section"><h3>과목</h3><p>이 학급에는 아직 과목이 없습니다.</p></section>';
  document.body.insertAdjacentHTML('beforeend', `<dialog class="app-dialog settings-dialog" id="classroom-settings-dialog"><div class="dialog-heading"><div><p class="eyebrow">${escapeHtml(classroom.name)}</p><h2>학급·과목 설정</h2></div><button class="dialog-close" id="close-classroom-settings" type="button" aria-label="설정 닫기">×</button></div><section class="settings-section"><h3>반 코드</h3><p>학생이 반 코드로 참여할 때 사용하는 코드예요.</p><form id="join-code-form" class="join-code-edit"><input id="edit-join-code" name="joinCode" value="${escapeHtml(classroom.joinCode)}" pattern="[A-Za-z0-9-]{3,12}" minlength="3" maxlength="12" required aria-label="새 반 코드"><button class="button secondary" type="submit">반 코드 저장</button></form><small>영문, 숫자, 하이픈 3~12자 · 다른 학급과 같은 코드는 사용할 수 없어요.</small></section>${courseSection}<section class="settings-section danger-zone"><h3>학급 전체 삭제</h3><p>학생 명단과 이 학급의 모든 과목·과제·완료 기록이 함께 삭제됩니다.</p><button class="button danger-button" id="delete-class-button" type="button">${escapeHtml(classroom.name)} 삭제</button></section></dialog>`);
  const dialog = document.querySelector('#classroom-settings-dialog');
  dialog.showModal();
  document.querySelector('#close-classroom-settings').addEventListener('click', () => { dialog.close(); dialog.remove(); });
  document.querySelector('#join-code-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const joinCode = new FormData(event.currentTarget).get('joinCode');
    const result = await act({ type: 'update-class-code', classId: classroom.id, joinCode }, '반 코드를 변경했어요.');
    if (result) { dialog.close(); dialog.remove(); }
  });
  document.querySelector('#delete-course-button')?.addEventListener('click', () => {
    dialog.close();
    dialog.remove();
    confirmIrreversibleDelete('과목', course.name, '이 과목의 과제와 완료 기록은 복구할 수 없습니다.', {
      type: 'delete-course', classId: classroom.id, courseId: course.id
    }, '과목과 관련 기록을 삭제했어요.');
  });
  document.querySelector('#delete-class-button').addEventListener('click', () => {
    dialog.close();
    dialog.remove();
    confirmIrreversibleDelete('학급', classroom.name, '학생 명단과 모든 과목·과제·완료 기록은 복구할 수 없습니다.', {
      type: 'delete-class', classId: classroom.id
    }, '학급과 모든 관련 자료를 삭제했어요.');
  });
}

function confirmIrreversibleDelete(kind, name, warning, action, successMessage) {
  document.querySelector('#irreversible-delete-dialog')?.remove();
  document.body.insertAdjacentHTML('beforeend', `<dialog class="app-dialog delete-dialog" id="irreversible-delete-dialog"><p class="delete-eyebrow">복구할 수 없는 삭제</p><h2>${escapeHtml(kind)}을(를) 삭제할까요?</h2><p class="delete-target">${escapeHtml(name)}</p><p class="delete-warning">${escapeHtml(warning)} 정말 삭제하시겠습니까?</p><div class="dialog-actions"><button class="button secondary" id="cancel-irreversible-delete" type="button">취소</button><button class="button danger-button" id="confirm-irreversible-delete" type="button">영구 삭제</button></div></dialog>`);
  const dialog = document.querySelector('#irreversible-delete-dialog');
  dialog.showModal();
  document.querySelector('#cancel-irreversible-delete').addEventListener('click', () => { dialog.close(); dialog.remove(); });
  document.querySelector('#confirm-irreversible-delete').addEventListener('click', async () => {
    const button = document.querySelector('#confirm-irreversible-delete');
    button.disabled = true;
    const result = await act({ ...action, confirmed: true }, successMessage);
    if (result) { dialog.close(); dialog.remove(); }
    else button.disabled = false;
  });
}

function showCourseForm() {
  const classroom = currentClass();
  const name = window.prompt(`${classroom.name}에 추가할 과목 이름을 입력해 주세요.`);
  if (name?.trim()) act({ type: 'create-course', classId: classroom.id, name }, '과목을 만들었어요. 전용 교사·학생 링크가 생성됐습니다.');
}

function showTaskForm() {
  const classroom = currentClass();
  app.querySelector('.panel-content').innerHTML = `<div class="join-panel"><h2>새 과제 만들기</h2><p>과제 제목은 필수이고, 제출 안내는 필요할 때만 적어도 돼요.</p><form id="task-form" class="form-grid"><div class="field"><label for="task-title">과제 제목</label><input id="task-title" name="title" required maxlength="90" placeholder="예: 독서 감상문"></div><div class="field"><label for="task-instructions">제출 안내 (선택)</label><textarea id="task-instructions" name="instructions" maxlength="500" placeholder="학생에게 보여줄 안내를 적어주세요."></textarea></div><div style="display:flex;gap:8px"><button class="button" type="submit">과제 추가</button><button class="button secondary" id="cancel-task" type="button">취소</button></div></form></div>`;
  document.querySelector('#task-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    act({ type: 'add-task', classId: classroom.id, courseId: currentCourse().id, title: values.get('title'), instructions: values.get('instructions') }, '과제를 추가했어요.');
  });
  document.querySelector('#cancel-task').addEventListener('click', render);
}

function showCopyTasksDialog(classroom, course) {
  const sources = state.courses.filter((candidate) =>
    candidate.classId !== classroom.id && candidate.name.trim().toLocaleLowerCase() === course.name.trim().toLocaleLowerCase() && candidate.tasks.length
  );
  if (!sources.length) return notify('다른 학급에 과제가 등록된 같은 과목이 없어요.', true);

  document.querySelector('#copy-tasks-dialog')?.remove();
  document.body.insertAdjacentHTML('beforeend', `<dialog class="app-dialog copy-tasks-dialog" id="copy-tasks-dialog"><p class="eyebrow">${escapeHtml(course.name)} / TASK COPY</p><h2>다른 학급에서 과제 가져오기</h2><p class="dialog-note">과제 제목과 안내만 복사합니다. 완료 기록은 복사되지 않아 이 학급의 진행 상황은 따로 관리돼요.</p><div class="field"><label for="copy-source-course">가져올 학급</label><select id="copy-source-course">${sources.map((source) => {
    const sourceClass = state.classrooms.find((item) => item.id === source.classId);
    return `<option value="${escapeHtml(source.id)}">${escapeHtml(sourceClass?.name || '학급')} · ${source.tasks.length}개 과제</option>`;
  }).join('')}</select></div><div id="copy-task-preview" class="copy-task-preview"></div><div class="dialog-actions"><button class="button secondary" id="cancel-task-copy" type="button">취소</button><button class="button" id="confirm-task-copy" type="button">선택한 과제 복사</button></div></dialog>`);
  const dialog = document.querySelector('#copy-tasks-dialog');
  const sourceSelect = document.querySelector('#copy-source-course');
  const preview = document.querySelector('#copy-task-preview');
  const updatePreview = () => {
    const source = sources.find((item) => item.id === sourceSelect.value);
    preview.innerHTML = source ? `<span class="section-kicker">복사할 과제</span><ul>${source.tasks.map((task) => `<li>${escapeHtml(task.title)}</li>`).join('')}</ul>` : '';
  };
  sourceSelect.addEventListener('change', updatePreview);
  updatePreview();
  dialog.showModal();
  document.querySelector('#cancel-task-copy').addEventListener('click', () => { dialog.close(); dialog.remove(); });
  document.querySelector('#confirm-task-copy').addEventListener('click', async () => {
    const response = await fetch('/api/copy-course-tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceCourseId: sourceSelect.value, targetCourseId: course.id })
    });
    const result = await response.json();
    if (!response.ok) return notify(result.error || '과제를 복사하지 못했어요.', true);
    state = result.state;
    dialog.close();
    dialog.remove();
    render();
    notify(`과제 ${result.copiedCount}개를 복사했어요${result.skippedCount ? ` · 같은 제목 ${result.skippedCount}개는 건너뜀` : ''}.`);
  });
}

function addStudentFromInput() {
  const field = document.querySelector('#add-student-name');
  if (!field.value.trim()) return notify('학생 이름을 입력해 주세요.', true);
  act({ type: 'add-student', classId: currentClass().id, name: field.value }, '학생을 명단에 추가했어요.');
}

function showStudentManager(classroom) {
  document.querySelector('#student-manager-dialog')?.remove();
  document.body.insertAdjacentHTML('beforeend', `<dialog class="app-dialog student-manager-dialog" id="student-manager-dialog"><div class="dialog-heading"><div><p class="eyebrow">${escapeHtml(classroom.name)}</p><h2>학생 명단 관리</h2></div><button class="dialog-close" id="close-student-manager" type="button" aria-label="학생 명단 닫기">×</button></div><p class="dialog-note">전학 등으로 명단에서 제외할 학생을 삭제할 수 있어요.</p><div class="student-manager-list">${classroom.students.map((student, index) => `<div class="student-manager-row"><span class="student-number">${String(student.number || index + 1).padStart(2, '0')}</span><strong>${escapeHtml(student.name)}</strong><button class="button danger-button small" type="button" data-remove-student="${escapeHtml(student.id)}">삭제</button></div>`).join('') || '<div class="empty-state">등록된 학생이 없습니다.</div>'}</div></dialog>`);
  const dialog = document.querySelector('#student-manager-dialog');
  dialog.showModal();
  document.querySelector('#close-student-manager').addEventListener('click', () => { dialog.close(); dialog.remove(); });
  document.querySelectorAll('[data-remove-student]').forEach((button) => button.addEventListener('click', () => {
    const student = classroom.students.find((entry) => entry.id === button.dataset.removeStudent);
    if (!student) return;
    dialog.close();
    dialog.remove();
    confirmIrreversibleDelete('학생', student.name, '학생 명단에서 삭제되고 이 학급의 모든 과목에서 해당 학생의 완료 기록도 삭제됩니다.', {
      type: 'delete-student', classId: classroom.id, studentId: student.id
    }, `${student.name} 학생을 명단에서 삭제했어요.`);
  }));
}

function openMiniRoster() {
  const classroom = currentClass();
  const course = currentCourse();
  const popup = window.open(`/mini-roster.html?classId=${encodeURIComponent(classroom.id)}&courseId=${encodeURIComponent(course.id)}&taskId=${encodeURIComponent(selectedTaskId)}`, 'moabom-mini-roster', 'popup,width=430,height=760,resizable=yes,scrollbars=yes');
  if (!popup) notify('팝업이 차단됐어요. 브라우저에서 팝업을 허용해 주세요.', true);
  else popup.focus();
}

function exportCourseCsv(classroom, course) {
  const protectFormula = (value) => {
    const text = String(value ?? '');
    return /^[=+\-@]/.test(text) ? `'${text}` : text;
  };
  const escapeCsv = (value) => `"${protectFormula(value).replace(/"/g, '""')}"`;
  const rows = [
    ['번호', '학생 이름', ...course.tasks.map((task) => task.title), '완료 과제 수'],
    ...classroom.students.map((student, index) => [
      student.number || index + 1,
      student.name,
      ...course.tasks.map((task) => isDone(classroom, student.id, task.id) ? '완료' : '진행 중'),
      `${countDone(classroom, student)} / ${course.tasks.length}`
    ])
  ];
  const csv = `\uFEFF${rows.map((row) => row.map(escapeCsv).join(',')).join('\r\n')}`;
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `course-progress-${course.id.slice(0, 8)}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify('과목의 전체 진행 현황 파일을 저장했어요.');
}

async function importRoster(file, classId) {
  try {
    const response = await fetch(apiUrl('/api/import-roster'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ classId, fileName: file.name, fileBase64: await fileToBase64(file) })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '명단을 불러오지 못했어요.');
    state = result.state;
    if (!selectedClassId && state.classrooms.length) {
      selectedClassId = state.classrooms[0].id;
      selectedCourseId = state.courses.find((course) => course.classId === selectedClassId)?.id || '';
    }
    render();
    notify(`${result.classCount}개 학급 반영${result.createdClassCount ? ` · 새 학급 ${result.createdClassCount}개 생성` : ''} · ${result.importedCount}명 추가${result.updatedCount ? ` · ${result.updatedCount}명 정보 갱신` : ''}${result.skippedCount ? ` · 중복 ${result.skippedCount}명 건너뜀` : ''}`);
  } catch (error) {
    notify(error.message, true);
  }
}

async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function renderStudent() {
  const linkedCourse = currentCourse();
  const isCourseLink = Boolean(pageParams.get('course'));
  if (!selectedStudent) {
    const linkedClassroom = state.classrooms.find((room) => room.id === linkedCourse?.classId);
    app.innerHTML = `<section class="student-page"><div class="student-welcome"><div><p class="eyebrow">${isCourseLink ? `${escapeHtml(linkedCourse?.name || 'COURSE')} / STUDENT ACCESS` : 'MY CLASS / MY TASKS'}</p><h1>내 과제 확인하기</h1><p>${isCourseLink ? `${escapeHtml(linkedClassroom?.name || '')} · 내 이름을 확인해 참여해요.` : '반 코드와 이름을 입력해 수업에 참여해요.'}</p></div><div class="student-progress-card"><span>과목</span><strong>${escapeHtml(linkedCourse?.name || '반 코드로 참여')}</strong></div></div><div class="join-panel"><h2>${isCourseLink ? `${escapeHtml(linkedCourse?.name || '과목')} 과제에 참여하기` : '우리 반에 참여하기'}</h2><p>${isCourseLink ? '이 링크는 해당 과목과 반에 연결되어 있어요. 명단에 등록된 이름을 입력하세요.' : '교사가 알려준 반 코드와 이름을 입력하세요. 명단에 아직 이름이 없다면 새로 등록할 수 있어요.'}</p><form class="form-grid" id="join-form">${isCourseLink ? '' : '<div class="field"><label for="join-code">반 코드</label><input id="join-code" name="code" required maxlength="12" placeholder="예: 62B" autocomplete="off"></div>'}<div class="field"><label for="join-name">내 이름</label><input id="join-name" name="name" required maxlength="30" placeholder="이름을 입력해요" autocomplete="name"></div><button class="button" type="submit">과제 확인하기</button></form></div></section>`;
    document.querySelector('#join-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      const classroom = isCourseLink
        ? state.classrooms.find((room) => room.id === linkedCourse?.classId)
        : state.classrooms.find((room) => room.joinCode.toUpperCase() === String(values.get('code')).trim().toUpperCase());
      if (!classroom) return notify('반 코드를 다시 확인해 주세요.', true);
      const course = isCourseLink ? linkedCourse : state.courses.find((entry) => entry.classId === classroom.id);
      if (!course) return notify('과목 링크가 올바르지 않습니다.', true);
      const name = String(values.get('name')).trim();
      let student = classroom.students.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
      if (student) {
        selectedClassId = classroom.id;
        selectedCourseId = course.id;
        selectedStudent = { classId: classroom.id, courseId: course.id, studentId: student.id };
        localStorage.setItem('moabom-student', JSON.stringify(selectedStudent));
        render();
      } else {
        notify('명단에서 이름을 찾지 못했어요. 이름을 다시 확인해 주세요.', true);
      }
    });
    return;
  }

  const course = state.courses.find((entry) => entry.id === (selectedStudent.courseId || selectedCourseId));
  const baseClassroom = state.classrooms.find((room) => room.id === (course?.classId || selectedStudent.classId));
  const classroom = courseClassroom(course);
  const student = baseClassroom?.students.find((entry) => entry.id === selectedStudent.studentId);
  if (!classroom || !student || !course) {
    selectedStudent = null;
    localStorage.removeItem('moabom-student');
    renderStudent();
    return;
  }
  selectedClassId = classroom.id;
  selectedCourseId = course.id;
  const done = countDone(classroom, student);
  app.innerHTML = `<section class="student-page"><div class="student-welcome"><div><p class="eyebrow">${escapeHtml(classroom.name)} · ${escapeHtml(course.name)} / YOUR CHECKLIST</p><h1>안녕하세요, ${escapeHtml(student.name)}님</h1><p>과제를 마치면 완료 버튼을 눌러 진행 상황을 알려주세요.</p></div><div class="student-progress-card"><span>${escapeHtml(course.name)} 과목 진행</span><strong>${done}<small> / ${classroom.tasks.length} 완료</small></strong></div></div><div class="student-task-list">${classroom.tasks.map((task, index) => {
    const complete = isDone(classroom, student.id, task.id);
    return `<article class="student-task ${complete ? 'done' : ''}"><span class="task-index">${String(index + 1).padStart(2, '0')}</span><div><h2>${escapeHtml(task.title)}</h2><p>${task.instructions ? escapeHtml(task.instructions) : '과제를 마친 뒤 완료 버튼을 눌러주세요.'}</p></div><button class="button ${complete ? 'complete' : ''}" type="button" data-task="${escapeHtml(task.id)}" aria-pressed="${complete}">${complete ? '완료했어요' : '[완료] 표시'}</button></article>`;
  }).join('') || '<div class="empty-state">아직 등록된 과제가 없어요. 교사에게 확인해 주세요.</div>'}</div><button class="button secondary small" id="switch-student" type="button" style="margin-top:16px">다른 학생으로 참여</button></section>`;
  document.querySelectorAll('[data-task]').forEach((button) => button.addEventListener('click', () => act({
    type: 'toggle-completion', classId: classroom.id, courseId: course.id, studentId: student.id, taskId: button.dataset.task
  }, button.getAttribute('aria-pressed') === 'true' ? '완료 표시를 취소했어요.' : '완료 상태를 교사에게 전달했어요.')));
  document.querySelector('#switch-student').addEventListener('click', () => {
    selectedStudent = null;
    localStorage.removeItem('moabom-student');
    render();
  });
}

function render() {
  updateHeader();
  if (role === 'teacher') renderTeacher();
  else renderStudent();
}

function renderAuth(mode = authMode, message = '') {
  authMode = mode;
  role = 'teacher';
  teacherProfile = null;
  document.querySelector('#topbar').hidden = true;
  document.querySelector('.role-switch').hidden = true;
  document.querySelector('#teacher-logout').hidden = true;
  document.querySelector('#teacher-account').hidden = true;
  document.querySelector('#teacher-recovery').hidden = true;
  document.querySelector('#footer-status').textContent = '로그인하면 내 수업 현황이 이 기기에 연결됩니다';
  const registering = mode === 'register';
  const resetting = mode === 'reset';
  const title = registering ? '선생님 계정 만들기' : resetting ? '비밀번호 재설정' : '내 수업에 로그인';
  const description = registering
    ? '계정은 선생님별로 분리됩니다. 비회원으로 만든 학급이 있으면 계정으로 옮기고, 복구 코드로 비밀번호를 재설정할 수 있어요.'
    : resetting ? '가입 때 받은 복구 코드로 새 비밀번호를 설정합니다.' : '같은 계정으로 로그인하면 교실 PC와 교무실 PC에서 내 수업을 이어서 볼 수 있어요. 이 브라우저의 비회원 자료도 계정으로 옮겨집니다.';
  const tabs = resetting
    ? '<button class="auth-tab active" type="button" data-auth-mode="login">로그인으로 돌아가기</button>'
    : `<button class="auth-tab ${registering ? '' : 'active'}" type="button" data-auth-mode="login">로그인</button><button class="auth-tab ${registering ? 'active' : ''}" type="button" data-auth-mode="register">계정 만들기</button>`;
  app.innerHTML = `<section class="auth-page"><div class="auth-story"><div><p class="eyebrow">MOABOM / TEACHER SPACE</p><h1>선생님만의 수업 공간</h1></div><p>같은 계정으로 로그인하면 교실 PC와 교무실 PC에서 내 학급과 과제를 이어서 확인할 수 있어요. 비회원 모드는 현재 브라우저에만 저장됩니다.</p></div><div class="auth-panel"><h2>${title}</h2><p class="auth-description">${description}</p><div class="auth-tabs" role="tablist" aria-label="로그인 또는 가입 선택">${tabs}</div>${message ? `<p class="auth-error" role="alert">${escapeHtml(message)}</p>` : ''}<form id="auth-form" class="form-grid">${registering ? '<div class="field"><label for="auth-name">선생님 이름</label><input id="auth-name" name="displayName" maxlength="50" autocomplete="name" required></div>' : ''}<div class="field"><label for="auth-email">이메일</label><input id="auth-email" name="email" type="email" autocomplete="email" required></div>${resetting ? '<div class="field"><label for="auth-recovery-code">복구 코드</label><input id="auth-recovery-code" name="recoveryCode" autocomplete="off" required></div>' : ''}<div class="field"><label for="auth-password">${resetting ? '새 비밀번호' : '비밀번호'}</label><input id="auth-password" name="password" type="password" minlength="8" maxlength="256" autocomplete="${registering || resetting ? 'new-password' : 'current-password'}" required>${registering || resetting ? '<small>8자 이상으로 설정해 주세요.</small>' : ''}</div><button class="button" type="submit">${registering ? '계정 만들기' : resetting ? '비밀번호 재설정' : '로그인'}</button></form>${!registering && !resetting ? '<button class="auth-text-button" id="forgot-password" type="button">비밀번호 찾기 / 재설정</button><div class="guest-option"><span>계정 없이 먼저 써보고 싶다면</span><button class="button secondary" id="start-guest" type="button">비회원으로 시작</button><small>이 브라우저에서만 이어 쓸 수 있어요. 다른 PC에서도 보려면 계정을 사용하세요.</small></div>' : ''}</div></section>`;
  app.insertAdjacentHTML('beforeend', '<p class="auth-credit">by raonpandaT <img class="byline-panda" src="/ai-images/moabom-panda.png" alt="" aria-hidden="true"></p>');
  document.querySelectorAll('[data-auth-mode]').forEach((button) => button.addEventListener('click', () => renderAuth(button.dataset.authMode)));
  document.querySelector('#forgot-password')?.addEventListener('click', () => renderAuth('reset'));
  document.querySelector('#start-guest')?.addEventListener('click', async () => {
    const response = await fetch('/api/auth/guest', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) return renderAuth('login', result.error || '비회원 공간을 시작하지 못했습니다.');
    teacherProfile = result.teacher;
    await startTeacherWorkspace();
  });
  document.querySelector('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const endpoint = registering ? '/api/auth/register' : resetting ? '/api/auth/reset-password' : '/api/auth/login';
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(values)) });
      const result = await response.json();
      if (!response.ok) return renderAuth(mode, result.error || '계정을 확인해 주세요.');
      teacherProfile = result.teacher;
      if (result.recoveryCode) return showRecoveryCodeDialog(result.recoveryCode, startTeacherWorkspace);
      await startTeacherWorkspace();
    } catch {
      renderAuth(mode, '서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.');
    }
  });
}

function showRecoveryCodeDialog(code, onContinue) {
  document.querySelector('#recovery-code-dialog')?.remove();
  document.body.insertAdjacentHTML('beforeend', `<dialog class="app-dialog recovery-dialog" id="recovery-code-dialog"><p class="eyebrow">ACCOUNT RECOVERY</p><h2>복구 코드를 안전하게 보관해 주세요</h2><p>비밀번호를 잊었을 때 사용할 수 있는 코드입니다. 이 화면을 닫으면 다시 볼 수 없으니 안전한 곳에 저장해 주세요.</p><code id="recovery-code-value">${escapeHtml(code)}</code><div class="dialog-actions"><button class="button secondary" id="copy-recovery-code" type="button">코드 복사</button><button class="button" id="saved-recovery-code" type="button">저장했어요</button></div></dialog>`);
  const dialog = document.querySelector('#recovery-code-dialog');
  dialog.showModal();
  dialog.addEventListener('cancel', (event) => event.preventDefault());
  document.querySelector('#copy-recovery-code').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code);
      notify('복구 코드를 복사했어요.');
    } catch {
      notify('복사가 안 되면 코드를 선택해 따로 저장해 주세요.', true);
    }
  });
  document.querySelector('#saved-recovery-code').addEventListener('click', async () => {
    dialog.close();
    dialog.remove();
    await onContinue();
  });
}

function showRecoveryCodeSetup() {
  document.querySelector('#recovery-setup-dialog')?.remove();
  document.body.insertAdjacentHTML('beforeend', `<dialog class="app-dialog recovery-dialog" id="recovery-setup-dialog"><p class="eyebrow">ACCOUNT RECOVERY</p><h2>복구 코드 재발급</h2><p>현재 비밀번호를 확인한 뒤 새 복구 코드를 만듭니다. 새 코드를 저장하면 이전 코드는 사용할 수 없어요.</p><form id="recovery-setup-form" class="form-grid"><div class="field"><label for="current-account-password">현재 비밀번호</label><input id="current-account-password" name="password" type="password" autocomplete="current-password" required></div><p id="recovery-setup-error" class="auth-error" hidden></p><div class="dialog-actions"><button class="button secondary" id="cancel-recovery-setup" type="button">취소</button><button class="button" type="submit">새 코드 만들기</button></div></form></dialog>`);
  const dialog = document.querySelector('#recovery-setup-dialog');
  dialog.showModal();
  document.querySelector('#cancel-recovery-setup').addEventListener('click', () => { dialog.close(); dialog.remove(); });
  document.querySelector('#recovery-setup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = new FormData(event.currentTarget).get('password');
    const response = await fetch('/api/auth/recovery-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    const result = await response.json();
    if (!response.ok) {
      const error = document.querySelector('#recovery-setup-error');
      error.textContent = result.error || '복구 코드를 발급하지 못했습니다.';
      error.hidden = false;
      return;
    }
    dialog.close();
    dialog.remove();
    showRecoveryCodeDialog(result.recoveryCode, async () => {});
  });
}

function applyRoleVisibility(isStudentLink = false) {
  document.querySelector('#topbar').hidden = !teacherProfile;
  const roleSwitch = document.querySelector('.role-switch');
  roleSwitch.hidden = !teacherProfile && !isStudentLink;
  document.querySelectorAll('.role-button').forEach((button) => {
    button.hidden = isStudentLink && button.dataset.role !== 'student';
  });
  const logout = document.querySelector('#teacher-logout');
  logout.hidden = !teacherProfile;
  logout.textContent = teacherProfile?.accountType === 'guest' ? '계정 로그인' : '로그아웃';
  const account = document.querySelector('#teacher-account');
  account.textContent = teacherProfile?.displayName || '';
  account.hidden = !teacherProfile;
  document.querySelector('#teacher-recovery').hidden = teacherProfile?.accountType !== 'teacher';
}

function attachLiveState(studentToken = '') {
  eventStream?.close();
  const eventsUrl = new URL('/api/events', window.location.origin);
  if (studentToken) eventsUrl.searchParams.set('studentToken', studentToken);
  eventStream = new EventSource(eventsUrl);
  eventStream.onmessage = (event) => {
    state = JSON.parse(event.data);
    if (selectedStudent && !state.classrooms.some((room) => room.id === selectedStudent.classId && room.students.some((student) => student.id === selectedStudent.studentId))) {
      selectedStudent = null;
      localStorage.removeItem('moabom-student');
    }
    render();
  };
  eventStream.onerror = () => { document.querySelector('#footer-status').textContent = '연결을 다시 시도하고 있어요'; };
  eventStream.onopen = () => { document.querySelector('#footer-status').textContent = '내 계정의 수업이 실시간으로 동기화됩니다'; };
}

function initializeWorkspace(next, studentToken = '') {
  state = next;
  const linkedCourse = studentToken && state.courses.find((course) => course.studentToken === studentToken || course.id === studentToken);
  selectedClassId = linkedCourse?.classId || state.classrooms.find((room) => room.id === selectedClassId)?.id || state.classrooms[0]?.id || '';
  selectedCourseId = linkedCourse?.id || state.courses.find((course) => course.id === selectedCourseId)?.id || state.courses.find((course) => course.classId === selectedClassId)?.id || '';
  if (role === 'student') {
    try { selectedStudent = JSON.parse(localStorage.getItem('moabom-student') || 'null'); } catch { selectedStudent = null; }
    if (selectedStudent && selectedCourseId && selectedStudent.courseId && selectedStudent.courseId !== selectedCourseId) selectedStudent = null;
    if (selectedStudent && !selectedStudent.courseId) selectedStudent.courseId = selectedCourseId;
    if (selectedStudent) localStorage.setItem('moabom-student', JSON.stringify(selectedStudent));
  } else {
    selectedStudent = null;
  }
  applyRoleVisibility(Boolean(studentToken));
  render();
  attachLiveState(studentToken);
  broadcastSelection();
}

async function startTeacherWorkspace() {
  try {
    const sessionResponse = await fetch('/api/auth/session');
    const session = await sessionResponse.json();
    if (!session.authenticated) return renderAuth('login');
    teacherProfile ||= session.teacher;
    const response = await fetch('/api/state');
    if (!response.ok) return renderAuth('login', '로그인 세션을 확인해 주세요.');
    role = 'teacher';
    initializeWorkspace(await response.json());
  } catch {
    renderAuth('login', '수업 정보를 불러오지 못했습니다. 다시 시도해 주세요.');
  }
}

async function startStudentWorkspace() {
  const studentToken = pageParams.get('course') || '';
  if (studentToken) {
    role = 'student';
    applyRoleVisibility(true);
    const stateUrl = new URL('/api/state', window.location.origin);
    stateUrl.searchParams.set('studentToken', studentToken);
    try {
      const response = await fetch(stateUrl);
      if (!response.ok) {
        app.innerHTML = '<section class="join-panel"><h2>학생 링크를 확인해 주세요</h2><p>과목 링크가 만료되었거나 올바르지 않습니다. 교사에게 새 링크를 요청해 주세요.</p></section>';
        return;
      }
      initializeWorkspace(await response.json(), studentToken);
    } catch {
      app.innerHTML = '<section class="join-panel"><h2>연결할 수 없습니다</h2><p>인터넷 연결을 확인하고 다시 열어주세요.</p></section>';
    }
    return;
  }
  const session = await fetch('/api/auth/session').then((response) => response.json()).catch(() => ({ authenticated: false }));
  if (!session.authenticated) return renderAuth('login');
  teacherProfile = session.teacher;
  role = 'student';
  await startTeacherWorkspace();
  role = 'student';
  render();
}

document.querySelectorAll('.role-button').forEach((button) => button.addEventListener('click', () => {
  role = button.dataset.role;
  if (role === 'teacher') startTeacherWorkspace();
  else startStudentWorkspace();
}));

document.querySelector('#teacher-logout').addEventListener('click', async () => {
  if (teacherProfile?.accountType === 'guest') {
    return renderAuth('login');
  }
  await fetch('/api/auth/logout', { method: 'POST' });
  eventStream?.close();
  teacherProfile = null;
  state = { classrooms: [], courses: [] };
  selectedClassId = '';
  selectedCourseId = '';
  selectedStudent = null;
  renderAuth('login', '로그아웃했습니다.');
});

document.querySelector('#teacher-recovery').addEventListener('click', showRecoveryCodeSetup);

if (role === 'student' && pageParams.has('course')) startStudentWorkspace();
else startTeacherWorkspace();
