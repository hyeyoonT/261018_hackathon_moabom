const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { unzipSync, strFromU8, strToU8, zipSync } = require('fflate');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, '.data', 'classrooms.json');
const LEGACY_DATA_FILE = path.join(ROOT, 'classrooms.json');
const PUBLIC_FILES = new Set(['index.html', 'styles.css', 'app.js', 'favicon.svg', 'mini-roster.html', 'mini-roster.css', 'mini-roster.js', '__preview-bridge.js', 'ai-images/moabom-panda.png']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

function makeSeed() {
  const names = ['김하윤', '이도윤', '박서아', '최지호', '정유나', '강민준', '윤채원', '장시우', '임서윤', '한지안', '오준서', '서예린'];
  const students = names.map((name, index) => ({ id: `student-${index + 1}`, name, seat: index }));
  return {
    classrooms: [{
      id: 'class-1', name: '6학년 2반', joinCode: '62B', rows: 3, cols: 4,
      students,
      tasks: [
        { id: 'task-1', title: '우리 동네 생태 지도', instructions: '학교 주변 생물을 조사하고 지도에 표시해요.' },
        { id: 'task-2', title: '생물 관찰 기록', instructions: '관찰한 생물의 특징을 세 가지 적어보세요.' },
        { id: 'task-3', title: '모둠 발표 자료', instructions: '' }
      ],
      completions: {
        'student-1': { 'task-1': true, 'task-2': true },
        'student-2': { 'task-1': true },
        'student-3': { 'task-1': true, 'task-2': true, 'task-3': true },
        'student-4': { 'task-1': true, 'task-2': true },
        'student-5': { 'task-1': true },
        'student-6': { 'task-1': true, 'task-2': true, 'task-3': true },
        'student-7': { 'task-1': true },
        'student-8': { 'task-1': true, 'task-2': true },
        'student-9': { 'task-1': true, 'task-2': true, 'task-3': true },
        'student-10': { 'task-1': true },
        'student-11': { 'task-1': true, 'task-2': true },
        'student-12': { 'task-1': true }
      }
    }]
  };
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    let initial;
    try {
      initial = JSON.parse(fs.readFileSync(LEGACY_DATA_FILE, 'utf8'));
    } catch {
      initial = makeSeed();
    }
    saveState(initial);
    return initial;
  }
}

function saveState(next) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(next, null, 2));
}

function resetSavedWorkspaces() {
  const summary = {
    classrooms: state.classrooms.length,
    courses: state.courses.length,
    students: state.classrooms.reduce((total, classroom) => total + classroom.students.length, 0),
    guests: state.guests.length
  };
  state.classrooms = [];
  state.courses = [];
  state.guests = [];
  delete state.schoolRoster;
  saveState(state);
  return summary;
}

let state = loadState();
let migratedCourses = false;
if (!Array.isArray(state.teachers)) {
  state.teachers = [];
  migratedCourses = true;
}
if (!Array.isArray(state.guests)) {
  state.guests = [];
  migratedCourses = true;
}
if (!Array.isArray(state.courses)) {
  state.courses = state.classrooms.map((classroom) => ({
    id: crypto.randomUUID(), name: '기본 과목', classId: classroom.id,
    tasks: classroom.tasks || [], completions: classroom.completions || {}
  }));
  migratedCourses = true;
}
for (const course of state.courses) {
  if (!course.studentToken) {
    course.studentToken = crypto.randomBytes(24).toString('base64url');
    migratedCourses = true;
  }
  const classroom = state.classrooms.find((item) => item.id === course.classId);
  if (classroom?.ownerId && !course.ownerId) {
    course.ownerId = classroom.ownerId;
    migratedCourses = true;
  }
}
if (migratedCourses) saveState(state);
const listeners = new Map();
const teacherSessions = new Map();
const authAttempts = new Map();

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function broadcast() {
  for (const [response, request] of listeners) {
    response.write(`data: ${JSON.stringify(visibleState(request))}\n\n`);
  }
}

function cookieValue(request, name) {
  const value = String(request.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return value ? value.slice(name.length + 1) : '';
}

function teacherForRequest(request) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (url.searchParams.has('studentToken') || url.searchParams.get('role') === 'student') return null;
  const session = teacherSessions.get(cookieValue(request, 'moabom_teacher'));
  if (!session || session.expiresAt < Date.now()) return null;
  return state.teachers.find((teacher) => teacher.id === session.teacherId) || null;
}

function guestForRequest(request) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (url.searchParams.has('studentToken') || url.searchParams.get('role') === 'student') return null;
  const token = cookieValue(request, 'moabom_guest');
  if (!token) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  return state.guests.find((guest) => guest.tokenHash === tokenHash && guest.expiresAt > Date.now()) || null;
}

function workspaceForRequest(request) {
  const teacher = teacherForRequest(request);
  if (teacher) return { ownerId: teacher.id, accountType: 'teacher', displayName: teacher.displayName };
  const guest = guestForRequest(request);
  if (guest) return { ownerId: `guest:${guest.id}`, accountType: 'guest', displayName: '비회원 모드' };
  return null;
}

function studentCourseForRequest(request) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const token = url.searchParams.get('studentToken');
  const legacyCourseId = token || (url.searchParams.get('role') === 'student' ? url.searchParams.get('course') : '');
  return state.courses.find((course) => course.ownerId && course.studentToken === token)
    || state.courses.find((course) => course.ownerId && course.id === legacyCourseId)
    || null;
}

function visibleState(request) {
  const workspace = workspaceForRequest(request);
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const courseId = url.searchParams.get('courseId');
  let courses;
  let classrooms;
  if (workspace) {
    courses = state.courses.filter((course) => course.ownerId === workspace.ownerId);
    classrooms = state.classrooms.filter((classroom) => classroom.ownerId === workspace.ownerId);
    if (courseId) {
      courses = courses.filter((course) => course.id === courseId);
      const classIds = new Set(courses.map((course) => course.classId));
      classrooms = classrooms.filter((classroom) => classIds.has(classroom.id));
    }
  } else {
    const course = studentCourseForRequest(request);
    if (!course) return { classrooms: [], courses: [] };
    courses = [course];
    classrooms = state.classrooms.filter((classroom) => classroom.id === course.classId);
  }
  return {
    classrooms: structuredClone(classrooms).map(({ ownerId, tasks, completions, ...classroom }) => classroom),
    courses: structuredClone(courses).map(({ ownerId, ...course }) => course)
  };
}

async function readJsonBody(request, limit = 1_000_000) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > limit) throw new Error('요청 내용이 너무 큽니다.');
  }
  return JSON.parse(body || '{}');
}

function setTeacherCookie(request, response, token) {
  const host = String(request.headers.host || '').split(':')[0];
  const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const secure = forwardedProto === 'https' || Boolean(request.socket.encrypted) || !['localhost', '127.0.0.1'].includes(host);
  response.setHeader('Set-Cookie', `moabom_teacher=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure ? '; Secure' : ''}`);
}

function setGuestCookie(request, response, token) {
  const host = String(request.headers.host || '').split(':')[0];
  const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const secure = forwardedProto === 'https' || Boolean(request.socket.encrypted) || !['localhost', '127.0.0.1'].includes(host);
  response.setHeader('Set-Cookie', `moabom_guest=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=15552000${secure ? '; Secure' : ''}`);
}

function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(String(code).replace(/-/g, '').toUpperCase()).digest('hex');
}

function newRecoveryCode() {
  return crypto.randomBytes(16).toString('hex').toUpperCase().match(/.{1,4}/g).join('-');
}

function moveGuestWorkspace(guest, teacherId) {
  if (!guest) return false;
  const guestOwnerId = `guest:${guest.id}`;
  const usedCodes = new Set(state.classrooms.filter((classroom) => classroom.ownerId === teacherId).map((classroom) => classroom.joinCode));
  for (const classroom of state.classrooms.filter((item) => item.ownerId === guestOwnerId)) {
    classroom.ownerId = teacherId;
    if (usedCodes.has(classroom.joinCode)) classroom.joinCode = newJoinCode(usedCodes);
    usedCodes.add(classroom.joinCode);
  }
  for (const course of state.courses) if (course.ownerId === guestOwnerId) course.ownerId = teacherId;
  state.guests = state.guests.filter((item) => item.id !== guest.id);
  return true;
}

function xmlAttribute(attributes, name) {
  return attributes.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1] || '';
}

function decodeXml(value) {
  return value.replace(/&#x([\da-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function columnNumber(reference) {
  const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase() || 'A';
  return [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function cellText(xml, sharedStrings) {
  const type = xml.match(/\bt="([^"]+)"/)?.[1] || '';
  if (type === 'inlineStr') {
    return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((match) => decodeXml(match[1])).join('');
  }
  const value = xml.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/)?.[1] || '';
  if (type === 's') return sharedStrings[Number(value)] || '';
  return decodeXml(value);
}

function extractXlsxSheets(buffer) {
  const files = unzipSync(new Uint8Array(buffer));
  const workbookPath = 'xl/workbook.xml';
  const relationshipPath = 'xl/_rels/workbook.xml.rels';
  const workbook = files[workbookPath] && strFromU8(files[workbookPath]);
  const relationships = files[relationshipPath] && strFromU8(files[relationshipPath]);
  if (!workbook || !relationships) throw new Error('엑셀 파일의 첫 번째 시트를 읽지 못했어요. .xlsx 파일인지 확인해 주세요.');

  const sharedXml = files['xl/sharedStrings.xml'] && strFromU8(files['xl/sharedStrings.xml']);
  const sharedStrings = sharedXml
    ? [...sharedXml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((item) => [...item[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((text) => decodeXml(text[1])).join(''))
    : [];
  const relationshipItems = [...relationships.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)];
  return [...workbook.matchAll(/<sheet\b([^>]*)\/?\s*>/g)].map((sheetMatch) => {
    const sheetName = decodeXml(xmlAttribute(sheetMatch[1], 'name'));
    const relationshipId = xmlAttribute(sheetMatch[1], 'r:id');
    const relationship = relationshipItems.find((match) => xmlAttribute(match[1], 'Id') === relationshipId);
    if (!relationship) throw new Error(`엑셀 시트 '${sheetName}'를 찾지 못했어요.`);
    const target = xmlAttribute(relationship[1], 'Target').replace(/^\//, '');
    const sheetPath = path.posix.normalize(target.startsWith('xl/') ? target : path.posix.join('xl', target));
    const sheet = files[sheetPath] && strFromU8(files[sheetPath]);
    if (!sheet) throw new Error(`엑셀 시트 '${sheetName}'의 내용을 읽지 못했어요.`);
    const rows = [...sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)].map((rowMatch) => {
      const cells = [];
      for (const cell of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const reference = xmlAttribute(cell[1], 'r');
        cells[columnNumber(reference)] = cellText(`${xmlAttribute(cell[1], 't') ? `t="${xmlAttribute(cell[1], 't')}"` : ''} ${cell[2] || ''}`, sharedStrings);
      }
      return cells;
    });
    return { name: sheetName, rows };
  });
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' && quoted && text[index + 1] === '"') { cell += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === ',' && !quoted) { row.push(cell.trim()); cell = ''; }
    else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = []; cell = '';
    } else cell += character;
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function normalizeHeader(value) {
  return String(value || '').replace(/[\s_]/g, '').toLowerCase();
}

function studentsFromRows(rows) {
  const headerNames = new Set(['이름', '학생이름', '학생명', '성명', 'name', 'student']);
  const numberNames = new Set(['번호', '학생번호', '출석번호', 'number', 'no']);
  let headerRow = -1;
  let nameColumn = 0;
  let numberColumn = -1;
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 8); rowIndex += 1) {
    const headers = rows[rowIndex].map(normalizeHeader);
    const nameIndex = headers.findIndex((value) => headerNames.has(value));
    if (nameIndex >= 0) {
      headerRow = rowIndex;
      nameColumn = nameIndex;
      numberColumn = headers.findIndex((value) => numberNames.has(value));
      break;
    }
  }
  return rows.slice(headerRow + 1).map((row) => ({
    name: String(row[nameColumn] || '').trim().slice(0, 30),
    number: numberColumn >= 0 ? String(row[numberColumn] || '').trim() : ''
  })).filter((student) => student.name);
}

function classSheetNames(classrooms = state.classrooms) {
  const used = new Set();
  return classrooms.map((classroom) => {
    const base = classroom.name.replace(/[:\\/?*\[\]\u0000-\u001F]/g, '-').replace(/^'+|'+$/g, '').trim().slice(0, 31) || '학급';
    let name = base;
    let suffixNumber = 2;
    while (used.has(name.toLowerCase())) {
      const suffix = ` (${suffixNumber})`;
      name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
      suffixNumber += 1;
    }
    used.add(name.toLowerCase());
    return { classId: classroom.id, name };
  });
}

function sheetNameMatches(value, classroom) {
  const normalize = (name) => String(name || '').trim().toLocaleLowerCase().replace(/\s/g, '').replace(/학년/g, '-').replace(/반/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const name = normalize(value);
  return [classroom.name, classSheetNames(state.classrooms.filter((item) => item.ownerId === classroom.ownerId)).find((entry) => entry.classId === classroom.id)?.name]
    .some((candidate) => normalize(candidate) === name);
}

function rosterGroupsFromRows(rows) {
  const classLabelHeaders = new Set(['학급', '학급명', '반명', 'class', 'classroom', 'classname']);
  const gradeHeaders = new Set(['학년', 'grade']);
  const classNumberHeaders = new Set(['반', '학급', 'class', 'classnumber', 'classno']);
  const numberHeaders = new Set(['번호', '학생번호', '출석번호', 'number', 'no']);
  const nameHeaders = new Set(['이름', '학생이름', '학생명', '성명', 'name', 'student']);
  for (let index = 0; index < Math.min(rows.length, 8); index += 1) {
    const headers = rows[index].map(normalizeHeader);
    const gradeColumn = headers.findIndex((value) => gradeHeaders.has(value));
    const classNumberColumn = headers.findIndex((value) => classNumberHeaders.has(value));
    const classLabelColumn = headers.findIndex((value) => classLabelHeaders.has(value));
    const numberColumn = headers.findIndex((value) => numberHeaders.has(value));
    const nameColumn = headers.findIndex((value) => nameHeaders.has(value));
    const usesGradeAndClass = gradeColumn >= 0 && classNumberColumn >= 0;
    const usesClassLabel = !usesGradeAndClass && classLabelColumn >= 0;
    if ((!usesGradeAndClass && !usesClassLabel) || numberColumn < 0 || nameColumn < 0) continue;
    const groups = new Map();
    for (const row of rows.slice(index + 1)) {
      const className = usesGradeAndClass
        ? `${String(row[gradeColumn] || '').trim()}학년 ${String(row[classNumberColumn] || '').trim()}반`
        : String(row[classLabelColumn] || '').trim();
      const name = String(row[nameColumn] || '').trim().slice(0, 30);
      if (!className.trim() || !name) continue;
      groups.set(className, [...(groups.get(className) || []), { name, number: String(row[numberColumn] || '').trim() }]);
    }
    return [...groups].map(([sheetName, students]) => ({ sheetName, students }));
  }
  return null;
}

function parseRosterFile(fileName, buffer) {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === '.csv') {
    const rows = parseCsvRows(buffer.toString('utf8').replace(/^\uFEFF/, ''));
    return rosterGroupsFromRows(rows) || [{ sheetName: '', students: studentsFromRows(rows) }];
  }
  if (extension !== '.xlsx') throw new Error('.xlsx 또는 .csv 형식 파일을 올려주세요.');
  const sheets = extractXlsxSheets(buffer).flatMap(({ name, rows }) => rosterGroupsFromRows(rows) || [{ sheetName: name, students: studentsFromRows(rows) }])
    .filter((sheet) => sheet.students.length);
  if (!sheets.length) throw new Error('엑셀 파일에서 학생 이름을 찾지 못했어요.');
  return sheets;
}

function makeTemplate(sheetNames, headers) {
  const escapeXml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const files = {};
  const sheetOverrides = sheetNames.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  const sheetLinks = sheetNames.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('');
  const sheetEntries = sheetNames.map((name, index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('');
  files['[Content_Types].xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheetOverrides}</Types>`);
  files['_rels/.rels'] = strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  files['xl/workbook.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetEntries}</sheets></workbook>`);
  files['xl/_rels/workbook.xml.rels'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetLinks}</Relationships>`);
  sheetNames.forEach((_, index) => {
    const headerCells = headers.map((header, column) => `<c r="${String.fromCharCode(65 + column)}1" t="inlineStr"><is><t>${escapeXml(header)}</t></is></c>`).join('');
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${headerCells}</row></sheetData></worksheet>`);
  });
  return zipSync(files, { level: 6 });
}

function newJoinCode(reserved = new Set()) {
  let code;
  do { code = crypto.randomBytes(3).toString('hex').toUpperCase(); }
  while (state.classrooms.some((classroom) => classroom.joinCode === code) || reserved.has(code));
  return code;
}

function applyAction(action, teacherId, studentLinkAccess = false) {
  const classrooms = state.classrooms;
  const classroom = classrooms.find((item) => item.id === action.classId);
  const course = state.courses.find((item) => item.id === action.courseId);

  if (action.type === 'create-class') {
    if (!teacherId) throw new Error('교사 계정으로 로그인해 주세요.');
    const name = String(action.name || '').trim();
    if (!name) throw new Error('반 이름을 입력해 주세요.');
    const requestedCode = String(action.joinCode || '').trim().toUpperCase();
    if (requestedCode && !/^[A-Z0-9-]{3,12}$/.test(requestedCode)) throw new Error('반 코드는 영문 대문자, 숫자, 하이픈으로 3~12자까지 설정할 수 있어요.');
    if (requestedCode && classrooms.some((classroom) => classroom.joinCode === requestedCode)) throw new Error('이미 사용 중인 반 코드예요. 다른 코드를 선택해 주세요.');
    const joinCode = requestedCode || newJoinCode();
    const id = crypto.randomUUID();
    classrooms.push({ id, ownerId: teacherId, name, joinCode, rows: 4, cols: 5, students: [], tasks: [], completions: {} });
    state.courses.push({ id: crypto.randomUUID(), ownerId: teacherId, studentToken: crypto.randomBytes(24).toString('base64url'), name: '기본 과목', classId: id, tasks: [], completions: {} });
    return;
  }
  if (action.type === 'update-class-code') {
    const requestedCode = String(action.joinCode || '').trim().toUpperCase();
    if (!teacherId || !classroom || classroom.ownerId !== teacherId) throw new Error('내 계정에 등록된 학급을 찾을 수 없습니다.');
    if (!/^[A-Z0-9-]{3,12}$/.test(requestedCode)) throw new Error('반 코드는 영문 대문자, 숫자, 하이픈으로 3~12자로 설정해 주세요.');
    if (classrooms.some((item) => item.id !== classroom.id && item.ownerId === teacherId && item.joinCode === requestedCode)) throw new Error('이미 사용 중인 반 코드예요. 다른 코드를 선택해 주세요.');
    classroom.joinCode = requestedCode;
    return;
  }
  if (action.type === 'delete-class') {
    if (!teacherId || !classroom || classroom.ownerId !== teacherId || action.confirmed !== true) throw new Error('학급 삭제 확인이 필요합니다.');
    state.classrooms = state.classrooms.filter((item) => item.id !== classroom.id);
    state.courses = state.courses.filter((item) => item.classId !== classroom.id);
    return;
  }
  if (action.type === 'delete-course') {
    if (!teacherId || !classroom || classroom.ownerId !== teacherId || !course || course.ownerId !== teacherId || action.confirmed !== true) throw new Error('과목 삭제 확인이 필요합니다.');
    state.courses = state.courses.filter((item) => item.id !== course.id);
    return;
  }
  if (action.type === 'create-course') {
    const title = String(action.name || '').trim();
    if (!teacherId || !classroom || classroom.ownerId !== teacherId || !title) throw new Error('반과 과목 이름을 확인해 주세요.');
    state.courses.push({ id: crypto.randomUUID(), ownerId: teacherId, studentToken: crypto.randomBytes(24).toString('base64url'), name: title, classId: classroom.id, tasks: [], completions: {} });
    return;
  }
  if (!classroom) throw new Error('반 정보를 찾을 수 없습니다.');
  if (teacherId && classroom.ownerId !== teacherId) throw new Error('다른 선생님의 학급은 변경할 수 없습니다.');
  if (!teacherId && (!studentLinkAccess || action.type !== 'toggle-completion')) {
    throw new Error('이 작업은 교사 계정으로 로그인해야 사용할 수 있습니다.');
  }

  if (action.type === 'delete-student') {
    if (!teacherId || action.confirmed !== true) throw new Error('학생 삭제 확인이 필요합니다.');
    const student = classroom.students.find((item) => item.id === action.studentId);
    if (!student) throw new Error('학생을 찾을 수 없습니다.');
    classroom.students = classroom.students.filter((item) => item.id !== student.id);
    if (classroom.completions) delete classroom.completions[student.id];
    for (const classCourse of state.courses.filter((item) => item.classId === classroom.id && item.ownerId === teacherId)) {
      delete classCourse.completions?.[student.id];
    }
    return;
  }

  if (action.type === 'add-task') {
    const title = String(action.title || '').trim();
    if (!teacherId || !title || !course || course.classId !== classroom.id || course.ownerId !== teacherId) throw new Error('과제 제목과 과목을 확인해 주세요.');
    course.tasks.push({ id: crypto.randomUUID(), title, instructions: String(action.instructions || '').trim() });
  } else if (action.type === 'add-student') {
    const name = String(action.name || '').trim();
    if (!name) throw new Error('학생 이름을 입력해 주세요.');
    const existing = classroom.students.find((student) => student.name.toLowerCase() === name.toLowerCase());
    if (existing) return;
    classroom.students.push({ id: crypto.randomUUID(), name, seat: classroom.students.length });
  } else if (action.type === 'toggle-completion') {
    const { studentId, taskId } = action;
    if (!course || course.classId !== classroom.id || (teacherId && course.ownerId !== teacherId) || (!teacherId && !studentLinkAccess) || !classroom.students.some((student) => student.id === studentId) || !course.tasks.some((task) => task.id === taskId)) {
      throw new Error('학생 또는 과제 정보를 찾을 수 없습니다.');
    }
    course.completions[studentId] ||= {};
    if (course.completions[studentId][taskId]) delete course.completions[studentId][taskId];
    else course.completions[studentId][taskId] = true;
  } else if (action.type === 'configure-seats') {
    classroom.cols = Math.max(1, Math.min(10, Number(action.cols) || 1));
    classroom.rows = Math.max(1, Math.min(10, Number(action.rows) || 1), Math.ceil(classroom.students.length / classroom.cols));
  } else if (action.type === 'move-seat') {
    const source = classroom.students.find((student) => student.id === action.studentId);
    if (!source) throw new Error('학생 정보를 찾을 수 없습니다.');
    const target = classroom.students.find((student) => student.seat === Number(action.seat));
    if (target) target.seat = source.seat;
    source.seat = Number(action.seat);
  } else {
    throw new Error('지원하지 않는 요청입니다.');
  }
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (url.pathname === '/api/auth/session' && request.method === 'GET') {
    const teacher = teacherForRequest(request);
    if (teacher) return sendJson(response, 200, { authenticated: true, teacher: { id: teacher.id, displayName: teacher.displayName, accountType: 'teacher' } });
    const guest = guestForRequest(request);
    return sendJson(response, 200, { authenticated: Boolean(guest), teacher: guest && { id: guest.id, displayName: '비회원 모드', accountType: 'guest' } });
  }
  if (url.pathname === '/api/auth/register' && request.method === 'POST') {
    readJsonBody(request).then((body) => {
      const displayName = String(body.displayName || '').trim().slice(0, 50);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (displayName.length < 2) throw new Error('선생님 이름을 두 글자 이상 입력해 주세요.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('이메일 주소를 확인해 주세요.');
      if (password.length < 8 || password.length > 256) throw new Error('비밀번호는 8~256자로 설정해 주세요.');
      if (state.teachers.some((teacher) => teacher.email === email)) throw new Error('이미 가입된 이메일입니다. 로그인해 주세요.');
      const recoveryCode = newRecoveryCode();
      const currentGuest = guestForRequest(request);
      const teacher = {
        id: crypto.randomUUID(), displayName, email,
        passwordSalt: crypto.randomBytes(16).toString('hex'),
        passwordHash: '', recoveryHash: hashRecoveryCode(recoveryCode)
      };
      teacher.passwordHash = crypto.scryptSync(password, teacher.passwordSalt, 64).toString('hex');
      moveGuestWorkspace(currentGuest, teacher.id);
      if (state.teachers.length === 0) {
        for (const classroom of state.classrooms) if (!classroom.ownerId) classroom.ownerId = teacher.id;
        for (const course of state.courses) {
          if (!course.ownerId) course.ownerId = state.classrooms.find((room) => room.id === course.classId)?.ownerId || teacher.id;
        }
      }
      state.teachers.push(teacher);
      saveState(state);
      const token = crypto.randomBytes(32).toString('hex');
      teacherSessions.set(token, { teacherId: teacher.id, expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
      setTeacherCookie(request, response, token);
      sendJson(response, 201, { authenticated: true, teacher: { id: teacher.id, displayName: teacher.displayName, accountType: 'teacher' }, recoveryCode });
    }).catch((error) => sendJson(response, 400, { error: error.message || '계정을 만들지 못했습니다.' }));
    return;
  }
  if (url.pathname === '/api/auth/login' && request.method === 'POST') {
    readJsonBody(request).then((body) => {
      const ip = request.socket.remoteAddress || 'unknown';
      const now = Date.now();
      const attempts = (authAttempts.get(ip) || []).filter((time) => now - time < 10 * 60 * 1000);
      if (attempts.length >= 10) return sendJson(response, 429, { error: '로그인 시도가 많습니다. 10분 뒤 다시 시도해 주세요.' });
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (password.length > 256) return sendJson(response, 401, { error: '이메일 또는 비밀번호를 확인해 주세요.' });
      const teacher = state.teachers.find((item) => item.email === email);
      const suppliedHash = teacher ? crypto.scryptSync(password, teacher.passwordSalt, 64) : crypto.scryptSync(password || 'invalid', 'moabom-invalid-user-salt', 64);
      const expectedHash = teacher ? Buffer.from(teacher.passwordHash, 'hex') : Buffer.alloc(64);
      const valid = suppliedHash.length === expectedHash.length && crypto.timingSafeEqual(suppliedHash, expectedHash);
      if (!teacher || !valid) {
        attempts.push(now);
        authAttempts.set(ip, attempts);
        return sendJson(response, 401, { error: '이메일 또는 비밀번호를 확인해 주세요.' });
      }
      authAttempts.delete(ip);
      const currentGuest = guestForRequest(request);
      const movedGuestWorkspace = moveGuestWorkspace(currentGuest, teacher.id);
      if (movedGuestWorkspace) saveState(state);
      let recoveryCode = '';
      if (!teacher.recoveryHash) {
        recoveryCode = newRecoveryCode();
        teacher.recoveryHash = hashRecoveryCode(recoveryCode);
        saveState(state);
      }
      const token = crypto.randomBytes(32).toString('hex');
      teacherSessions.set(token, { teacherId: teacher.id, expiresAt: now + 12 * 60 * 60 * 1000 });
      setTeacherCookie(request, response, token);
      sendJson(response, 200, { authenticated: true, teacher: { id: teacher.id, displayName: teacher.displayName, accountType: 'teacher' }, recoveryCode });
    }).catch((error) => sendJson(response, 400, { error: error.message || '로그인 요청을 확인할 수 없습니다.' }));
    return;
  }
  if (url.pathname === '/api/auth/recovery-code' && request.method === 'POST') {
    const teacher = teacherForRequest(request);
    if (!teacher) return sendJson(response, 401, { error: '로그인 후 복구 코드를 재발급할 수 있습니다.' });
    readJsonBody(request).then((body) => {
      const password = String(body.password || '');
      if (password.length > 256) return sendJson(response, 401, { error: '현재 비밀번호가 맞지 않습니다.' });
      const suppliedHash = crypto.scryptSync(password, teacher.passwordSalt, 64);
      const expectedHash = Buffer.from(teacher.passwordHash, 'hex');
      if (suppliedHash.length !== expectedHash.length || !crypto.timingSafeEqual(suppliedHash, expectedHash)) return sendJson(response, 401, { error: '현재 비밀번호가 맞지 않습니다.' });
      const recoveryCode = newRecoveryCode();
      teacher.recoveryHash = hashRecoveryCode(recoveryCode);
      saveState(state);
      sendJson(response, 200, { recoveryCode });
    }).catch((error) => sendJson(response, 400, { error: error.message || '복구 코드를 만들지 못했습니다.' }));
    return;
  }
  if (url.pathname === '/api/auth/reset-password' && request.method === 'POST') {
    readJsonBody(request).then((body) => {
      const ip = request.socket.remoteAddress || 'unknown';
      const now = Date.now();
      const attempts = (authAttempts.get(ip) || []).filter((time) => now - time < 10 * 60 * 1000);
      if (attempts.length >= 10) return sendJson(response, 429, { error: '재설정 시도가 많습니다. 10분 뒤 다시 시도해 주세요.' });
      const email = String(body.email || '').trim().toLowerCase();
      const recoveryCode = String(body.recoveryCode || '');
      const password = String(body.password || '');
      const teacher = state.teachers.find((item) => item.email === email);
      const providedHash = Buffer.from(hashRecoveryCode(recoveryCode), 'hex');
      const storedHash = teacher?.recoveryHash ? Buffer.from(teacher.recoveryHash, 'hex') : Buffer.alloc(32);
      const validCode = providedHash.length === storedHash.length && crypto.timingSafeEqual(providedHash, storedHash);
      if (!teacher || !validCode) {
        attempts.push(now);
        authAttempts.set(ip, attempts);
        return sendJson(response, 400, { error: '이메일 또는 복구 코드를 확인해 주세요.' });
      }
      if (password.length < 8 || password.length > 256) throw new Error('새 비밀번호는 8~256자로 설정해 주세요.');
      authAttempts.delete(ip);
      const recoveryCodeNext = newRecoveryCode();
      teacher.passwordSalt = crypto.randomBytes(16).toString('hex');
      teacher.passwordHash = crypto.scryptSync(password, teacher.passwordSalt, 64).toString('hex');
      teacher.recoveryHash = hashRecoveryCode(recoveryCodeNext);
      saveState(state);
      for (const [token, session] of teacherSessions) if (session.teacherId === teacher.id) teacherSessions.delete(token);
      const token = crypto.randomBytes(32).toString('hex');
      teacherSessions.set(token, { teacherId: teacher.id, expiresAt: now + 12 * 60 * 60 * 1000 });
      setTeacherCookie(request, response, token);
      sendJson(response, 200, { authenticated: true, teacher: { id: teacher.id, displayName: teacher.displayName, accountType: 'teacher' }, recoveryCode: recoveryCodeNext });
    }).catch((error) => sendJson(response, 400, { error: error.message || '비밀번호를 재설정하지 못했습니다.' }));
    return;
  }
  if (url.pathname === '/api/auth/guest' && request.method === 'POST') {
    let guest = guestForRequest(request);
    if (!guest) {
      const token = crypto.randomBytes(32).toString('base64url');
      guest = { id: crypto.randomUUID(), tokenHash: crypto.createHash('sha256').update(token).digest('hex'), expiresAt: Date.now() + 180 * 24 * 60 * 60 * 1000 };
      state.guests.push(guest);
      saveState(state);
      setGuestCookie(request, response, token);
    }
    return sendJson(response, 200, { authenticated: true, teacher: { id: guest.id, displayName: '비회원 모드', accountType: 'guest' } });
  }
  if (false && url.pathname === '/api/auth/reset-password' && request.method === 'POST') {
    readJsonBody(request).then((body) => {
      const ip = request.socket.remoteAddress || 'unknown';
      const now = Date.now();
      const attempts = (authAttempts.get(ip) || []).filter((time) => now - time < 10 * 60 * 1000);
      if (attempts.length >= 10) return sendJson(response, 429, { error: '재설정 시도가 많습니다. 10분 뒤 다시 시도해 주세요.' });
      const email = String(body.email || '').trim().toLowerCase();
      const recoveryCode = String(body.recoveryCode || '');
      const password = String(body.password || '');
      const teacher = state.teachers.find((item) => item.email === email);
      const providedCodeHash = Buffer.from(hashRecoveryCode(recoveryCode), 'hex');
      const expectedCodeHash = teacher?.recoveryHash ? Buffer.from(teacher.recoveryHash, 'hex') : Buffer.alloc(32);
      const validCode = providedCodeHash.length === expectedCodeHash.length && crypto.timingSafeEqual(providedCodeHash, expectedCodeHash);
      if (!teacher || !validCode) {
        attempts.push(now);
        authAttempts.set(ip, attempts);
        return sendJson(response, 400, { error: '이메일 또는 복구 코드를 확인해 주세요.' });
      }
      if (password.length < 8 || password.length > 256) throw new Error('새 비밀번호는 8~256자로 설정해 주세요.');
      authAttempts.delete(ip);
      teacher.passwordSalt = crypto.randomBytes(16).toString('hex');
      teacher.passwordHash = crypto.scryptSync(password, teacher.passwordSalt, 64).toString('hex');
      saveState(state);
      for (const [token, session] of teacherSessions) if (session.teacherId === teacher.id) teacherSessions.delete(token);
      const token = crypto.randomBytes(32).toString('hex');
      teacherSessions.set(token, { teacherId: teacher.id, expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
      setTeacherCookie(request, response, token);
      sendJson(response, 200, { authenticated: true, teacher: { id: teacher.id, displayName: teacher.displayName, accountType: 'teacher' } });
    }).catch((error) => sendJson(response, 400, { error: error.message || '비밀번호를 재설정하지 못했습니다.' }));
    return;
  }
  if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
    teacherSessions.delete(cookieValue(request, 'moabom_teacher'));
    const host = String(request.headers.host || '').split(':')[0];
    const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const secure = forwardedProto === 'https' || Boolean(request.socket.encrypted) || !['localhost', '127.0.0.1'].includes(host);
    response.setHeader('Set-Cookie', `moabom_teacher=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`);
    return sendJson(response, 200, { authenticated: false });
  }
  if (url.pathname === '/api/state' && request.method === 'GET') {
    if (!workspaceForRequest(request) && !studentCourseForRequest(request)) return sendJson(response, 401, { error: '교사 로그인 또는 학생용 과목 링크가 필요합니다.' });
    return sendJson(response, 200, visibleState(request));
  }
  if (url.pathname === '/api/events' && request.method === 'GET') {
    if (!workspaceForRequest(request) && !studentCourseForRequest(request)) return sendJson(response, 401, { error: '접근 권한이 없습니다.' });
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    response.write(`data: ${JSON.stringify(visibleState(request))}\n\n`);
    listeners.set(response, request);
    const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 15_000);
    request.on('close', () => {
      clearInterval(heartbeat);
      listeners.delete(response);
    });
    return;
  }
  if (url.pathname === '/api/action' && request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      try {
        const action = JSON.parse(body || '{}');
        const workspace = workspaceForRequest(request);
        const studentCourse = studentCourseForRequest(request);
        const studentLinkAccess = !workspace && studentCourse?.id === action.courseId && studentCourse.classId === action.classId && action.type === 'toggle-completion';
        if (!workspace && !studentLinkAccess) return sendJson(response, 401, { error: '로그인하거나 학생용 과목 링크로 접속해 주세요.' });
        applyAction(action, workspace?.ownerId || null, studentLinkAccess);
        saveState(state);
        broadcast();
        sendJson(response, 200, visibleState(request));
      } catch (error) {
        sendJson(response, 400, { error: error.message || '요청을 처리하지 못했습니다.' });
      }
    });
    return;
  }
  if (url.pathname === '/api/copy-course-tasks' && request.method === 'POST') {
    const workspace = workspaceForRequest(request);
    if (!workspace) return sendJson(response, 401, { error: '로그인 후 과제를 복사할 수 있습니다.' });
    readJsonBody(request).then(({ sourceCourseId, targetCourseId }) => {
      const source = state.courses.find((course) => course.id === sourceCourseId && course.ownerId === workspace.ownerId);
      const target = state.courses.find((course) => course.id === targetCourseId && course.ownerId === workspace.ownerId);
      if (!source || !target) throw new Error('내 워크스페이스의 과목을 찾을 수 없습니다.');
      if (source.id === target.id || source.classId === target.classId) throw new Error('다른 학급의 같은 과목을 선택해 주세요.');
      if (source.name.trim().toLocaleLowerCase() !== target.name.trim().toLocaleLowerCase()) throw new Error('과목명이 같은 경우에만 과제를 복사할 수 있습니다.');
      if (!source.tasks.length) throw new Error('선택한 학급에 복사할 과제가 없습니다.');

      const existingTitles = new Set(target.tasks.map((task) => task.title.trim().toLocaleLowerCase()));
      let copiedCount = 0;
      let skippedCount = 0;
      for (const task of source.tasks) {
        const title = task.title.trim().toLocaleLowerCase();
        if (existingTitles.has(title)) {
          skippedCount += 1;
          continue;
        }
        existingTitles.add(title);
        target.tasks.push({ id: crypto.randomUUID(), title: task.title, instructions: task.instructions || '' });
        copiedCount += 1;
      }
      saveState(state);
      broadcast();
      sendJson(response, 200, { state: visibleState(request), copiedCount, skippedCount });
    }).catch((error) => sendJson(response, 400, { error: error.message || '과제를 복사하지 못했습니다.' }));
    return;
  }
  if (url.pathname === '/api/import-roster' && request.method === 'POST') {
    const workspace = workspaceForRequest(request);
    if (!workspace) return sendJson(response, 401, { error: '워크스페이스를 시작한 뒤 명단을 올릴 수 있습니다.' });
    let body = '';
    let tooLarge = false;
    request.on('data', (chunk) => {
      if (Buffer.byteLength(body) + chunk.length > 10_000_000) { tooLarge = true; return; }
      if (!tooLarge) body += chunk;
    });
    request.on('end', () => {
      if (tooLarge) return sendJson(response, 413, { error: '파일은 7MB 이하로 올려주세요.' });
      try {
        const { classId, fileName, fileBase64 } = JSON.parse(body || '{}');
        const selectedClass = classId ? state.classrooms.find((item) => item.id === classId) : null;
        if (classId && (!selectedClass || selectedClass.ownerId !== workspace.ownerId)) throw new Error('내 워크스페이스에 등록된 반을 찾을 수 없습니다.');
        const buffer = Buffer.from(String(fileBase64 || ''), 'base64');
        if (!buffer.length || buffer.length > 7_000_000) throw new Error('파일은 7MB 이하로 올려주세요.');
        const sheets = parseRosterFile(String(fileName || ''), buffer);
        if (!sheets.length) throw new Error('학생 이름을 찾지 못했어요. 각 시트에 번호, 이름 열을 넣어주세요.');
        const isGenericSheet = (name) => {
          const normalized = normalizeHeader(name);
          return normalized === '학생명단' || /^(sheet|시트)\d*$/.test(normalized);
        };
        const reservedCodes = new Set();
        const pendingClasses = new Map();
        const assignments = sheets.map((sheet) => {
          const sheetName = String(sheet.sheetName || '').trim();
          const genericSheet = !sheetName || isGenericSheet(sheetName);
          let classroom = !genericSheet
            ? state.classrooms.find((room) => room.ownerId === workspace.ownerId && sheetNameMatches(sheetName, room))
            : null;
          if (!classroom && genericSheet && sheets.length === 1) {
            classroom = selectedClass;
          }
          if (!classroom && !genericSheet) {
            const existingPending = [...pendingClasses.values()].find((room) => sheetNameMatches(sheetName, room));
            classroom = existingPending;
            if (!classroom) {
              const name = sheetName.slice(0, 50);
              classroom = { id: crypto.randomUUID(), ownerId: workspace.ownerId, name, joinCode: newJoinCode(reservedCodes), rows: 4, cols: 5, students: [], tasks: [], completions: {} };
              reservedCodes.add(classroom.joinCode);
              pendingClasses.set(classroom.id, classroom);
            }
          }
          if (!classroom) throw new Error(`'${sheetName || '학생 명단'}' 시트에 맞는 학급이 없어요. 학급을 선택하거나 시트 이름을 새 학급 이름으로 정해 주세요.`);
          return { classroom, students: sheet.students };
        });
        for (const classroom of pendingClasses.values()) {
          state.classrooms.push(classroom);
          state.courses.push({ id: crypto.randomUUID(), ownerId: workspace.ownerId, studentToken: crypto.randomBytes(24).toString('base64url'), name: '기본 과목', classId: classroom.id, tasks: [], completions: {} });
        }
        let importedCount = 0;
        let updatedCount = 0;
        let skippedCount = 0;
        const affectedClasses = new Set();
        for (const { classroom: targetClass, students } of assignments) {
          if (students.length) affectedClasses.add(targetClass.id);
          for (const imported of students) {
            const name = imported.name;
            if (!name) continue;
            const existing = imported.number
              ? targetClass.students.find((student) => String(student.number || '') === imported.number)
              : null;
            if (existing) {
              if (existing.name !== name) {
                existing.name = name;
                updatedCount += 1;
              } else skippedCount += 1;
              continue;
            }
            if (targetClass.students.some((student) => student.name.toLowerCase() === name.toLowerCase())) {
              skippedCount += 1;
              continue;
            }
            targetClass.students.push({ id: crypto.randomUUID(), name, number: imported.number, seat: targetClass.students.length });
            importedCount += 1;
          }
          targetClass.rows = Math.max(targetClass.rows, Math.ceil(targetClass.students.length / targetClass.cols));
        }
        saveState(state);
        broadcast();
        sendJson(response, 200, { state: visibleState(request), importedCount, updatedCount, skippedCount, classCount: affectedClasses.size, createdClassCount: pendingClasses.size });
      } catch (error) {
        sendJson(response, 400, { error: error.message || '엑셀 파일을 읽지 못했습니다.' });
      }
    });
    return;
  }
  if (url.pathname === '/api/templates/class-roster' && request.method === 'GET') {
    const workspace = workspaceForRequest(request);
    if (!workspace) return sendJson(response, 401, { error: '워크스페이스를 시작한 뒤 양식을 받을 수 있습니다.' });
    const sheets = classSheetNames(state.classrooms.filter((room) => room.ownerId === workspace.ownerId));
    const file = makeTemplate(sheets.length ? sheets.map((sheet) => sheet.name) : ['학생 명단'], sheets.length ? ['번호', '이름'] : ['학급', '번호', '이름']);
    response.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="all-class-rosters.xlsx"',
      'Content-Length': file.length
    });
    return response.end(Buffer.from(file));
  }
  if (url.pathname === '/api/course-qr' && request.method === 'GET') {
    const course = state.courses.find((item) => item.id === url.searchParams.get('courseId'));
    if (!course) return sendJson(response, 404, { error: '과목을 찾을 수 없습니다.' });
    const host = String(request.headers['x-forwarded-host'] || request.headers.host || 'localhost').split(',')[0].trim();
    const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const protocol = forwardedProto === 'https' || request.socket.encrypted ? 'https:' : 'http:';
    let origin = `${protocol}//${host}`;
    try {
      const requestedOrigin = new URL(url.searchParams.get('origin') || '');
      if (requestedOrigin.protocol === 'http:' || requestedOrigin.protocol === 'https:') origin = requestedOrigin.origin;
    } catch { /* Fall back to the request host. */ }
    const studentUrl = new URL('/', origin);
    studentUrl.searchParams.set('course', course.studentToken);
    studentUrl.searchParams.set('role', 'student');
    QRCode.toString(studentUrl.href, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 220, color: { dark: '#1d2c2b', light: '#ffffff' } })
      .then((svg) => {
        response.writeHead(200, {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'private, max-age=300',
          'Content-Disposition': url.searchParams.has('download') ? 'attachment; filename="moabom-student-qr.svg"' : 'inline'
        });
        response.end(svg);
      })
      .catch(() => sendJson(response, 500, { error: 'QR 코드를 생성하지 못했습니다.' }));
    return;
  }
  if (url.pathname === '/favicon.ico' && request.method === 'GET') {
    response.writeHead(302, { Location: '/favicon.svg' });
    return response.end();
  }

  const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const filePath = path.resolve(ROOT, requested);
  if (!filePath.startsWith(`${ROOT}${path.sep}`) || !PUBLIC_FILES.has(requested) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    response.writeHead(404);
    return response.end('Not found');
  }
  response.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(response);
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Class Progress Board listening on http://0.0.0.0:${PORT}`);
  });
}

module.exports = { parseRosterFile, makeTemplate, server, state, applyAction, resetSavedWorkspaces };
