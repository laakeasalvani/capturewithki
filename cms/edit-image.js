import { storage } from './firebase.js';
import { ref, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-storage.js';
import { getField, setField } from './content-store.js';
import { onEditingChange } from './auth.js';

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_EDGE = 6000;
const JPEG_QUALITY = 0.95;

// Earlier this capped every upload at 2560px and re-encoded it at quality 85.
// Khiara could see the difference, and she was right to: her camera produces
// ~5239px files, so every photo was both scaled down and put through a second
// round of JPEG compression on top of the camera's own. That is generation
// loss, and it shows in skin, hair and fabric.
//
// So the ceiling now sits above her camera rather than below it. A normal
// photo never reaches the canvas at all — it uploads byte-for-byte as she
// exported it. Only something genuinely enormous, a stitched panorama or a
// scan, is touched, and then at quality 95, which is visually indistinguishable.
//
// The tradeoff is deliberate and hers: full-size photos mean a heavier page,
// most of all on the 36-image Portfolio grid. Quality won.
//
// Exported so the behaviour can be tested without performing a real upload.
export function capIfEnormous(file) {
  return new Promise(function (resolve) {
    // Anything we cannot decode (HEIC, a corrupt file, an exotic format) is
    // passed through untouched rather than rejected — better a large upload
    // than a blocked one.
    if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) { resolve(file); return; }

    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = function () {
      URL.revokeObjectURL(url);
      // The common path, and the point of the change: her file, untouched.
      if (Math.max(img.naturalWidth, img.naturalHeight) <= MAX_EDGE) {
        resolve(file);
        return;
      }

      const scale = MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);

      canvas.toBlob(function (blob) {
        // Never make things worse: if re-encoding gained nothing, keep hers.
        if (!blob || blob.size >= file.size) { resolve(file); return; }
        resolve(new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }));
      }, 'image/jpeg', JPEG_QUALITY);
    };

    img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

export async function uploadImage(file, pathPrefix) {
  if (!file.type.startsWith('image/')) {
    throw new Error('Please choose an image file.');
  }
  if (file.size > MAX_BYTES) {
    throw new Error('That image is larger than 50MB.');
  }
  const ready = await capIfEnormous(file);
  const safeName = ready.name.replace(/[^\w.\-]+/g, '_').slice(-100);
  const path = 'uploads/' + pathPrefix + '/' + Date.now() + '-' + safeName;
  const fileRef = ref(storage, path);
  await uploadBytes(fileRef, ready);
  return getDownloadURL(fileRef);
}

function applyImage(img) {
  const id = img.getAttribute('data-cms-id');
  const value = getField(id, img.__cmsFallback);
  img.src = value;
  if (value !== img.__cmsFallback) {
    img.removeAttribute('srcset');
  }
}

function buildOverlay(img) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cms-image-overlay';
  btn.textContent = 'Change photo';
  btn.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', function () {
      const file = input.files[0];
      if (!file) return;
      const id = img.getAttribute('data-cms-id');
      uploadImage(file, id)
        .then(function (url) { return setField(id, url); })
        .then(function () { applyImage(img); })
        .catch(function (err) { alert(err.message); });
    });
    input.click();
  });
  return btn;
}

export function initImageEditing() {
  const images = document.querySelectorAll('[data-cms-type="image"]');

  images.forEach(function (img) {
    img.__cmsFallback = img.getAttribute('src');
    applyImage(img);
    img.parentNode.appendChild(buildOverlay(img));
  });

  onEditingChange(function (active) {
    document.querySelectorAll('.cms-image-overlay').forEach(function (btn) {
      btn.classList.toggle('cms-visible', active);
    });
  });
}
