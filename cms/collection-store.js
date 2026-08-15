import { db } from './firebase.js';
import {
  collection,
  doc,
  getDocs,
  addDoc,
  deleteDoc,
  updateDoc,
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

// `order` must be unique within a collection. A duplicate makes Firestore fall
// back to sorting by document id, so the item lands somewhere nobody chose —
// and the caller's reasonable assumption that a new item is now last stops
// being true.
//
// Callers used to pass `items.length` as the order. That holds only while the
// numbers run 0..n-1 with no gaps, and deleting never renumbered, so a single
// deletion broke it permanently: with orders {0, 2}, length is 2, and the next
// item collides with the existing 2. Live data had reached heroSlides
// {2,2,2,3} and testimonials {1,2,2} exactly this way.
//
// Exported for testing.
export function orderForNewItem(items) {
  let max = -1;
  items.forEach(function (item) {
    if (typeof item.order === 'number' && item.order > max) max = item.order;
  });
  return max + 1;
}

// The order is computed here rather than trusted from the caller: all four
// collections made the same mistake, so the rule belongs in one place where it
// cannot drift back.
export async function addCollectionItem(name, data) {
  const existing = await loadCollection(name);
  const itemRef = await addDoc(
    collection(db, name),
    Object.assign({}, data, { order: orderForNewItem(existing) })
  );
  return itemRef.id;
}

// Renumber to a clean 0..n-1. Gaps are what let a later add collide, so closing
// them after a delete is what stops the corruption recurring — and it repairs a
// collection that is already tangled.
export async function normalizeOrder(name) {
  const items = await loadCollection(name);
  const alreadyClean = items.every(function (item, i) { return item.order === i; });
  if (alreadyClean) return;
  await reorderCollection(name, items.map(function (item) { return item.id; }));
}

export async function deleteCollectionItem(name, id) {
  await deleteDoc(doc(db, name, id));
  await normalizeOrder(name);
}

export async function updateCollectionItem(name, id, data) {
  await updateDoc(doc(db, name, id), data);
}

export async function reorderCollection(name, orderedIds) {
  const batch = writeBatch(db);
  orderedIds.forEach(function (id, index) {
    batch.update(doc(db, name, id), { order: index });
  });
  await batch.commit();
}
