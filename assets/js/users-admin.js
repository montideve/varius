// assets/js/users-admin.js
// Actualizado:
// - Verificación de emails/teléfonos duplicados usando consultas a Firestore (no solo cache local).
// - Mantiene filtros y paginado; searchInput, roleFilter, statusFilter, perPageSelect.
// - Mejora UI: iconos en acciones, inputs estilizados (CSS en usuarios.html).
//
// NOTA: Requiere importar `where` en las queries.

import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import {
    getAuth,
    onAuthStateChanged,
    createUserWithEmailAndPassword,
    sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import {
    getFirestore,
    collection,
    getDocs,
    getDoc,
    doc,
    setDoc,
    updateDoc,
    serverTimestamp,
    query,
    orderBy,
    where
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";

// Inicializa Firebase (solo si no está)
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// DOM elementos de filtros y paginado
const openAddBtn = document.getElementById('openAddBtn');
const userModal = document.getElementById('userModal');
const closeModalBtn = document.getElementById('closeModal');
const userForm = document.getElementById('userForm');
const cancelBtn = document.getElementById('cancelBtn');
const toastEl = document.getElementById('toast');
const usersBody = document.getElementById('usersBody');

const searchInput = document.getElementById('searchInput');
const roleFilter = document.getElementById('roleFilter');
const statusFilter = document.getElementById('statusFilter');
const perPageSelect = document.getElementById('perPageSelect');
const prevPageBtn = document.getElementById('prevPage');
const nextPageBtn = document.getElementById('nextPage');
const pageInfo = document.getElementById('pageInfo');
const applyFiltersBtn = document.getElementById('applyFilters');
const clearFiltersBtn = document.getElementById('clearFilters');

let allUsers = []; // cache (para renderizado y filtros)
let filteredUsers = [];
let currentPage = 1;
let presenceMap = {}; // uid -> 'online'|'offline'

// Toast helper
function showToast(msg, time = 2500) {
    if (!toastEl) { console.log(msg); return; }
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    setTimeout(() => toastEl.classList.add('hidden'), time);
}

// utils
function escapeHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function roleClass(role) {
    if (!role) return 'role-vendedor';
    switch (role) {
        case 'administrador': return 'role-admin';
        case 'vendedor': return 'role-vendedor';
        case 'motorizado': return 'role-motorizado';
        default: return 'role-vendedor';
    }
}
function statusClass(status) {
    switch ((status || '').toLowerCase()) {
        case 'activo': return 'status-activo';
        case 'inactivo': return 'status-inactivo';
        case 'suspendido': return 'status-suspendido';
        default: return 'status-inactivo';
    }
}

// Load users from Firestore (cache for rendering & filtering)
async function loadUsers() {
    try {
        const q = query(collection(db, 'users'), orderBy('createdAt', 'desc'));
        const snap = await getDocs(q);
        allUsers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        applyFiltersAndRender();
    } catch (err) {
        console.error('Error loading users', err);
        showToast('Error cargando usuarios.');
    }
}

// Firestore duplicate checks (robustos):
// - isEmailTaken: consulta a Firestore buscando coincidencias exactas en campo email.
//   Consideración: Firestore es case-sensitive. Si tus correos se guardan en distintos casos,
//   lo ideal es normalizar (guardar emailLower) para consultas. Aquí intentamos con email tal cual y con lowercase.
async function isEmailTaken(email, excludeId = null) {
    if (!email) return false;
    const emailVariants = Array.from(new Set([email, email.toLowerCase()]));
    for (const e of emailVariants) {
        const q = query(collection(db, 'users'), where('email', '==', e));
        const snap = await getDocs(q);
        for (const d of snap.docs) {
            if (d.id !== excludeId) return true;
        }
    }
    return false;
}

async function isPhoneTaken(phone, excludeId = null) {
    if (!phone) return false;
    const q = query(collection(db, 'users'), where('phone', '==', phone));
    const snap = await getDocs(q);
    for (const d of snap.docs) {
        if (d.id !== excludeId) return true;
    }
    return false;
}

// Filtering & pagination
function applyFiltersAndRender() {
    const q = (searchInput?.value || '').toLowerCase();
    const r = roleFilter?.value || '';
    const s = statusFilter?.value || '';

    filteredUsers = allUsers.filter(u => {
        const matchesQ = !q || (
            (u.name || '').toLowerCase().includes(q) ||
            (u.email || '').toLowerCase().includes(q) ||
            (String(u.phone || '')).toLowerCase().includes(q)
        );
        const matchesRole = !r || u.role === r;
        const matchesStatus = !s || (u.status === s);
        return matchesQ && matchesRole && matchesStatus;
    });

    currentPage = 1;
    renderTable();
}

function renderTable() {
    const perPageVal = perPageSelect?.value || '10';
    const perPage = perPageVal === 'all' ? (filteredUsers.length || 1) : parseInt(perPageVal, 10);
    const total = filteredUsers.length;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * perPage;
    const pageItems = filteredUsers.slice(start, start + perPage);

    if (pageInfo) pageInfo.textContent = `${total ? start + 1 : 0}-${Math.min(start + perPage, total)} de ${total}`;

    usersBody.innerHTML = '';
    for (const u of pageItems) {
        const state = presenceMap[u.id] || 'offline';
        const dotClass = state === 'online' ? 'online-dot' : 'offline-dot';

        const tr = document.createElement('tr');

        // Nombre cell
        const tdName = document.createElement('td');
        tdName.innerHTML = `
            <div class="user-cell">
                <div class="${dotClass}" title="${state === 'online' ? 'Conectado' : 'Desconectado'}" aria-hidden="true"></div>
                <div class="user-meta-stack">
                    <div class="user-name">${escapeHtml(u.name || '—')}</div>
                    <div class="user-email">${escapeHtml(u.email || '')}</div>
                </div>
            </div>
        `;

        // role
        const tdRole = document.createElement('td');
        tdRole.innerHTML = `<span class="role-badge ${roleClass(u.role)}">${escapeHtml(u.role || '')}</span>`;

        // phone
        const tdPhone = document.createElement('td');
        tdPhone.textContent = u.phone || '';

        // status
        const tdStatus = document.createElement('td');
        tdStatus.innerHTML = `<span class="status-badge ${statusClass(u.status)}">${escapeHtml(u.status || 'Activo')}</span>`;

        // actions: icon buttons
        const tdActions = document.createElement('td');
        tdActions.innerHTML = `
            <div class="actions">
                <button class="icon-btn btn-edit" data-id="${u.id}" title="Editar" aria-label="Editar">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-pencil-square" viewBox="0 0 16 16">
                    <path d="M15.502 1.94a.5.5 0 0 1 0 .706L14.459 3.69l-2-2L13.502.646a.5.5 0 0 1 .707 0l1.293 1.293zm-1.75 2.456-2-2L4.939 9.21a.5.5 0 0 0-.121.196l-.805 2.414a.25.25 0 0 0 .316.316l2.414-.805a.5.5 0 0 0 .196-.12l6.813-6.814z"/>
                    <path fill-rule="evenodd" d="M1 13.5A1.5 1.5 0 0 0 2.5 15h11a1.5 1.5 0 0 0 1.5-1.5v-6a.5.5 0 0 0-1 0v6a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5H9a.5.5 0 0 0 0-1H2.5A1.5 1.5 0 0 0 1 2.5z"/>
                    </svg>
                </button>
                <button class="icon-btn btn-suspender" data-id="${u.id}" title="Suspender" aria-label="Suspender">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-trash" viewBox="0 0 16 16">
                    <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0z"/>
                    <path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4zM2.5 3h11V2h-11z"/>
                    </svg>
                </button>
            </div>
        `;

        tr.appendChild(tdName);
        tr.appendChild(tdRole);
        tr.appendChild(tdPhone);
        tr.appendChild(tdStatus);
        tr.appendChild(tdActions);

        usersBody.appendChild(tr);
    }

    // Attach handlers
    usersBody.querySelectorAll('.btn-edit').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = e.currentTarget.getAttribute('data-id');
            const docSnap = allUsers.find(x => x.id === id);
            if (docSnap) openModal('edit', docSnap);
        });
    });

    usersBody.querySelectorAll('.btn-suspend').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const id = e.currentTarget.getAttribute('data-id');
            if (!confirm('¿Suspender usuario? Esto marcará su estado como "Suspendido".')) return;
            try {
                await updateDoc(doc(db, 'users', id), { status: 'Suspendido' });
                showToast('Usuario suspendido.');
                await loadUsers();
            } catch (err) {
                console.error('Error suspending user', err);
                showToast('Error al suspender usuario.');
            }
        });
    });
}

// Modal helpers and validation
function openModal(mode = 'add', data = null) {
    const titleEl = document.getElementById('modalTitle');
    const userIdEl = document.getElementById('userId');
    titleEl.textContent = mode === 'add' ? 'Agregar Usuario' : 'Editar Usuario';
    userIdEl.value = data?.id || '';

    document.getElementById('u_name').value = data?.name || '';
    document.getElementById('u_email').value = data?.email || '';
    document.getElementById('u_phone').value = data?.phone || '';
    document.getElementById('u_role').value = data?.role || '';
    document.getElementById('u_status').value = data?.status || 'Activo';
    document.getElementById('u_password').value = '';
    document.getElementById('u_password_confirm').value = '';

    ['u_name_alert', 'u_email_alert', 'u_phone_alert', 'u_password_alert', 'u_password_confirm_alert'].forEach(id => {
        const el = document.getElementById(id); if (el) el.textContent = '';
    });

    userModal.classList.remove('hidden');
    userModal.setAttribute('aria-hidden', 'false');
}
function closeModal() {
    userModal.classList.add('hidden');
    userModal.setAttribute('aria-hidden', 'true');
}

function validateForm(values, isEdit = false) {
    let ok = true;
    if (!values.name || !values.name.trim()) { document.getElementById('u_name_alert').textContent = 'El nombre es requerido.'; ok = false; } else document.getElementById('u_name_alert').textContent = '';
    if (!values.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) { document.getElementById('u_email_alert').textContent = 'Correo inválido.'; ok = false; } else document.getElementById('u_email_alert').textContent = '';
    if (values.phone && !/^\d{6,15}$/.test(values.phone)) { document.getElementById('u_phone_alert').textContent = 'Teléfono debe tener 6-15 dígitos o estar vacío.'; ok = false; } else document.getElementById('u_phone_alert').textContent = '';

    if (!values.role) { ok = false; showToast('Selecciona un rol.'); }

    if (!isEdit || (values.password || values.confirm)) {
        const pw = values.password || '';
        const confirm = values.confirm || '';
        const okLen = pw.length >= 6 && pw.length <= 8;
        const okUpper = /[A-Z]/.test(pw);
        const okLower = /[a-z]/.test(pw);
        const okNumber = /[0-9]/.test(pw);
        const okSpecial = /[\W_]/.test(pw);
        if (!okLen || !okUpper || !okLower || !okNumber || !okSpecial) {
            document.getElementById('u_password_alert').textContent = 'La contraseña debe tener 6-8 caracteres e incluir mayúscula, minúscula, número y carácter especial.'; ok = false;
        } else document.getElementById('u_password_alert').textContent = '';
        if (pw !== confirm) { document.getElementById('u_password_confirm_alert').textContent = 'Las contraseñas no coinciden.'; ok = false; } else document.getElementById('u_password_confirm_alert').textContent = '';
    } else {
        document.getElementById('u_password_alert').textContent = '';
        document.getElementById('u_password_confirm_alert').textContent = '';
    }
    return ok;
}

// form submit (uses Firestore queries to check duplicates)
userForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const userId = document.getElementById('userId').value;
    const name = document.getElementById('u_name').value.trim();
    const email = document.getElementById('u_email').value.trim();
    const phone = (document.getElementById('u_phone').value || '').replace(/\D/g, '').trim();
    const role = document.getElementById('u_role').value;
    const status = document.getElementById('u_status').value;
    const password = document.getElementById('u_password').value;
    const confirm = document.getElementById('u_password_confirm').value;

    const values = { name, email, phone, role, status, password, confirm };
    const isEdit = !!userId;
    if (!validateForm(values, isEdit)) return;

    // Check duplicates using Firestore queries
    try {
        const emailTaken = await isEmailTaken(email, isEdit ? userId : null);
        if (emailTaken) {
            document.getElementById('u_email_alert').textContent = 'El correo ya está registrado.';
            return;
        }
        if (phone) {
            const phoneTaken = await isPhoneTaken(phone, isEdit ? userId : null);
            if (phoneTaken) {
                document.getElementById('u_phone_alert').textContent = 'El teléfono ya está registrado.';
                return;
            }
        }
    } catch (err) {
        console.error('Error checking duplicates', err);
        showToast('Error verificando duplicados. Intenta más tarde.');
        return;
    }

    try {
        if (!isEdit) {
            const cred = await createUserWithEmailAndPassword(auth, email, password);
            const uid = cred.user.uid;
            await setDoc(doc(db, 'users', uid), {
                name, email, phone, role, status: status || 'Activo', createdAt: serverTimestamp(), createdBy: auth.currentUser?.uid || null
            });
            showToast('Usuario creado correctamente.');
        } else {
            await updateDoc(doc(db, 'users', userId), { name, phone, role, status });
            if (password) {
                await sendPasswordResetEmail(auth, email);
                showToast('Datos actualizados. Email para restablecer contraseña enviado.');
            } else showToast('Usuario actualizado.');
        }
        closeModal();
        await loadUsers();
    } catch (err) {
        console.error('Error saving user', err);
        if (err && err.code === 'auth/email-already-in-use') {
            document.getElementById('u_email_alert').textContent = 'El correo ya está registrado en Auth.';
            return;
        }
        showToast('Error guardando usuario. Revisa consola.');
    }
});

// UI wiring
openAddBtn?.addEventListener('click', () => openModal('add'));
closeModalBtn?.addEventListener('click', closeModal);
cancelBtn?.addEventListener('click', (e) => { e.preventDefault(); closeModal(); });
userModal?.addEventListener('click', (e) => { if (e.target === userModal) closeModal(); });

// phone input digits-only
const phoneInput = document.getElementById('u_phone');
if (phoneInput) phoneInput.addEventListener('input', (e) => { e.target.value = (e.target.value || '').replace(/\D/g, ''); document.getElementById('u_phone_alert').textContent = ''; });

// Filters & pagination events
applyFiltersBtn?.addEventListener('click', () => applyFiltersAndRender());
clearFiltersBtn?.addEventListener('click', () => { searchInput.value = ''; roleFilter.value = ''; statusFilter.value = ''; perPageSelect.value = '10'; applyFiltersAndRender(); });
searchInput?.addEventListener('input', () => { currentPage = 1; applyFiltersAndRender(); });
roleFilter?.addEventListener('change', () => { currentPage = 1; applyFiltersAndRender(); });
statusFilter?.addEventListener('change', () => { currentPage = 1; applyFiltersAndRender(); });
perPageSelect?.addEventListener('change', () => { currentPage = 1; renderTable(); });
prevPageBtn?.addEventListener('click', () => { if (currentPage > 1) { currentPage--; renderTable(); } });
nextPageBtn?.addEventListener('click', () => {
    const perPageVal = perPageSelect?.value || '10';
    const perPage = perPageVal === 'all' ? (filteredUsers.length || 1) : parseInt(perPageVal, 10);
    const totalPages = Math.max(1, Math.ceil(filteredUsers.length / perPage));
    if (currentPage < totalPages) currentPage++;
    renderTable();
});

// Presence: listen events (presence.js should emit presence:list)
window.addEventListener('presence:list', (e) => {
    const users = (e.detail && e.detail.users) || [];
    const map = {};
    for (const u of users) map[u.uid] = (u.state === 'online' ? 'online' : 'offline');
    presenceMap = map;
    if (allUsers.length) renderTable();
});

// Auth check & initial load
onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = 'index.html'; return; }
    try {
        const s = await getDoc(doc(db, 'users', user.uid));
        if (s.exists()) {
            const r = s.data().role;
            if (r !== 'administrador') { window.location.href = `/admin/${r}.html`; return; }
        } else { window.location.href = 'index.html'; return; }
    } catch (err) {
        console.error('Role check error', err);
    }
    await loadUsers();
});