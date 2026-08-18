import { storage } from '../cms/firebase.js';
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-storage.js';
import {
  collection, doc, setDoc, updateDoc, deleteDoc, increment, getDocs, query, orderBy, limit
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

// Browsing a wedding gallery must not pull the originals. A 500-photo gallery
// at full quality is well over a gigabyte; a phone would simply never finish.
// So every photo is stored twice: her untouched original, and a preview.
const THUMB_EDGE = 1600;
const THUMB_QUALITY = 0.82;

// Same canvas approach as cms/edit-image.js, which has been shrinking her CMS
// uploads in production. Anything undecodable (HEIC, a corrupt file) has no
// preview rather than blocking the upload — the grid falls back to the
// original for those, which is slower but never broken.
function makeThumbnail(file) {
  return new Promise(function (resolve) {
    if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) { resolve(null); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      const longest = Math.max(img.naturalWidth, img.naturalHeight);
      const scale = Math.min(1, THUMB_EDGE / longest);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(function (blob) { resolve(blob || null); }, 'image/jpeg', THUMB_QUALITY);
    };
    img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// Read once per batch, not once per photo. At 500 photos, computing this
// inside the loop would be 500 extra queries — and the `items.length` habit
// that corrupted all four CMS collections is exactly what not to repeat.
export async function nextPhotoOrder(db, galleryId) {
  const q = query(collection(db, 'galleries', galleryId, 'photos'), orderBy('order', 'desc'), limit(1));
  const snap = await getDocs(q);
  if (snap.empty) return 0;
  const top = snap.docs[0].data().order;
  return typeof top === 'number' ? top + 1 : 0;
}

// NOTE on getDownloadURL, deliberately:
//
// A Storage download URL carries its own token and works WITHOUT the Firebase
// session — it bypasses storage.rules. So the rules are not what stops a
// stranger opening one of these; they stop a stranger LISTING them. The URLs
// live only on the gallery's photo records, which Firestore refuses to anyone
// without the gallery's token, and they die with the files at expiry.
//
// The alternative — storing paths and fetching bytes with getBlob() so rules
// apply per request — is stricter, but it needs bucket CORS configured for
// capturewithki.com and holds every image in memory. That is a real setup step
// and a real failure mode for an 800-photo grid, in exchange for closing a gap
// that only opens if a paying client shares their own photos. The path is
// stored alongside the URL so this can be revisited without a migration.
export async function uploadGalleryPhoto(opts) {
  const db = opts.db;
  const galleryId = opts.galleryId;
  const file = opts.file;
  const order = typeof opts.order === 'number' ? opts.order : 0;

  if (!file.type || !file.type.startsWith('image/')) {
    throw new Error('Not an image: ' + file.name);
  }

  const photoRef = doc(collection(db, 'galleries', galleryId, 'photos'));
  const photoId = photoRef.id;
  const safeName = String(file.name || 'photo').replace(/[^\w.\-]+/g, '_').slice(-100);

  const fullPath = 'galleries/' + galleryId + '/full/' + photoId + '-' + safeName;
  const fullRef = ref(storage, fullPath);
  await uploadBytes(fullRef, file);
  const fullUrl = await getDownloadURL(fullRef);

  let thumbPath = null;
  let thumbUrl = null;
  const thumb = await makeThumbnail(file);
  if (thumb) {
    thumbPath = 'galleries/' + galleryId + '/thumb/' + photoId + '.jpg';
    const thumbRef = ref(storage, thumbPath);
    await uploadBytes(thumbRef, thumb);
    thumbUrl = await getDownloadURL(thumbRef);
  }

  await setDoc(photoRef, {
    name: file.name || safeName,
    order: order,
    fullPath: fullPath,
    fullUrl: fullUrl,
    thumbPath: thumbPath,
    // No preview means the grid shows the original for this one photo.
    thumbUrl: thumbUrl || fullUrl,
    bytes: file.size || 0
  });

  const galleryRef = doc(db, 'galleries', galleryId);
  const patch = { photoCount: increment(1) };
  if (order === 0) patch.coverThumb = thumbUrl || fullUrl;
  await updateDoc(galleryRef, patch);

  return { photoId: photoId, thumbUrl: thumbUrl || fullUrl, fullUrl: fullUrl };
}

// Remove one photo: the original, its preview, and the record.
//
// The files go first. If a file delete fails we stop, leaving the record in
// place — so she sees the photo is still there and can try again, rather than
// the record vanishing while the file quietly keeps costing storage until the
// gallery expires.
//
// A file that is already gone is not an error. Re-running a half-finished
// delete should finish the job, not refuse.
export async function deleteGalleryPhoto(opts) {
  const db = opts.db;
  const galleryId = opts.galleryId;
  const photo = opts.photo;

  for (const path of [photo.fullPath, photo.thumbPath]) {
    if (!path) continue;
    try {
      await deleteObject(ref(storage, path));
    } catch (err) {
      if (err && err.code === 'storage/object-not-found') continue;
      throw err;
    }
  }

  await deleteDoc(doc(db, 'galleries', galleryId, 'photos', photo.id));

  const patch = { photoCount: increment(-1) };
  // The cover pointed at the photo just removed, so it would render broken.
  if (opts.wasCover) patch.coverThumb = opts.nextCover || null;
  await updateDoc(doc(db, 'galleries', galleryId), patch);
}

export async function loadGalleryPhotos(db, galleryId) {
  const snap = await getDocs(query(collection(db, 'galleries', galleryId, 'photos'), orderBy('order')));
  const out = [];
  snap.forEach(function (d) { out.push(Object.assign({ id: d.id }, d.data())); });
  return out;
}
