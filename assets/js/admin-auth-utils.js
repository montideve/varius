import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

/**
 * Get fresh ID token for current admin.
 * @returns {Promise<string>}
 */
export async function getAdminIdToken() {
    const user = auth.currentUser;
    if (!user) throw new Error('No authenticated user');
    return await user.getIdToken(true);
}

/**
 * Check if currently signed user is admin based on /users document role field.
 * @returns {Promise<boolean>}
 */
export async function verifyAdminOnClient() {
    const user = auth.currentUser;
    if (!user) return false;
    const snap = await getDoc(doc(db, 'users', user.uid));
    return snap.exists() && snap.data().role === 'administrador';
}