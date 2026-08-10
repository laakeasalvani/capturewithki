import { db } from './firebase.js';
import {
  collection,
  doc,
  getDocs,
  addDoc,
  deleteDoc,
  writeBatch,
  query,
  orderBy
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

export async function loadCollection(name) {
  try {
    const q = query(collection(db, name), orderBy('order'));
    const snap = await getDocs(q);
    const items = [];
    snap.forEach(function (docSnap) {
      items.push(Object.assign({ id: docSnap.id }, docSnap.data()));
    });
    return items;
  } catch (e) {
    return [];
  }
}

export async function seedCollection(name, items) {
  const batch = writeBatch(db);
  items.forEach(function (item, index) {
    const itemRef = doc(collection(db, name));
    batch.set(itemRef, Object.assign({}, item, { order: index }));
  });
  await batch.commit();
}

export async function addCollectionItem(name, data, order) {
  const itemRef = await addDoc(collection(db, name), Object.assign({}, data, { order: order }));
  return itemRef.id;
}

export async function deleteCollectionItem(name, id) {
  await deleteDoc(doc(db, name, id));
}

export async function reorderCollection(name, orderedIds) {
  const batch = writeBatch(db);
  orderedIds.forEach(function (id, index) {
    batch.update(doc(db, name, id), { order: index });
  });
  await batch.commit();
}
