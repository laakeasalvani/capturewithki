import { storage } from './firebase.js';
import { ref, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-storage.js';
import { getField, setField } from './content-store.js';
import { onEditingChange } from './auth.js';

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_EDGE = 2560;
const JPEG_QUALITY = 0.85;

// Photos come straight off a camera or phone — often 5000px and several MB.
// A full-screen hero never needs more than about 2560px, so serving the
// original means visitors download roughly four times the pixels they can
// see. Shrinking here, in her browser, also makes her own upload faster.
// The original file on her device is never touched.
function shrink(file) {
  return new Promise(function (resolve) {
    // Anything we cannot decode (HEIC, a corrupt file, an exotic format) is
    // passed through untouched rather than rejected — better a large upload
    // than a blocked one.
    if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) { resolve(file); return; }

    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = function () {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
      // Already small enough AND already efficiently encoded: leave it alone.
      if (scale === 1 && file.size <= 900 * 1024) { resolve(file); return; }

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
    throw new Error('That image is larger than 25MB.');
  }
  const ready = await shrink(file);
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
