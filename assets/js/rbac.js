import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getFirestore(app);


export async function getUserRole(uid) {
    if (!uid) return '';
    try {
        const userRef = doc(db, 'users', uid);
        const snap = await getDoc(userRef);
        if (!snap.exists()) return '';
        return snap.data().role || '';
    } catch (err) {
        console.error('rbac.getUserRole error', err);
        return '';
    }
}

export function applyUiRestrictions(role) {
    try {
        // admin has all rights -> nothing to hide
        if (role === 'administrador') {
            // ensure admin-only elements are shown
            document.querySelectorAll('.admin-only').forEach(el => el.style.display = '');
            document.querySelectorAll('.seller-only').forEach(el => el.style.display = '');
            document.querySelectorAll('.motor-only').forEach(el => el.style.display = '');
            return;
        }

        // hide admin-only for everyone who is not admin
        document.querySelectorAll('.admin-only').forEach(el => {
            // remove from layout but keep for devs to toggle
            el.style.display = 'none';
        });

        // if vendedor: seller may have seller-only features.
        if (role === 'vendedor') {
            // hide motorizado-only sections
            document.querySelectorAll('.motor-only').forEach(el => el.style.display = 'none');
            // show seller-only if present
            document.querySelectorAll('.seller-only').forEach(el => el.style.display = '');
            return;
        }

        // if motorizado:
        if (role === 'motorizado') {
            // hide seller-only
            document.querySelectorAll('.seller-only').forEach(el => el.style.display = 'none');
            // show motor-only
            document.querySelectorAll('.motor-only').forEach(el => el.style.display = '');
            return;
        }

    } catch (err) {
        console.error('applyUiRestrictions error', err);
    }
}