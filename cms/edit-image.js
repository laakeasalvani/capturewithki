import { storage } from './firebase.js';
import { ref, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-storage.js';
import { getField, setField } from './content-store.js';
import { onAdminChange } from './auth.js';

const MAX_BYTES = 10 * 1024 * 1024;

export async function uploadImage(file, pathPrefix) {
  if (!file.type.startsWith('image/')) {
    throw new Error('Please choose an image file.');
  }
  if (file.size > MAX_BYTES) {
    throw new Error('That image is larger than 10MB.');
  }
  const safeName = file.name.replace(/[^\w.\-]+/g, '_').slice(-100);
  const path = 'uploads/' + pathPrefix + '/' + Date.now() + '-' + safeName;
  const fileRef = ref(storage, path);
  await uploadBytes(fileRef, file);
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

  onAdminChange(function (active) {
    document.querySelectorAll('.cms-image-overlay').forEach(function (btn) {
      btn.classList.toggle('cms-visible', active);
    });
  });
}
