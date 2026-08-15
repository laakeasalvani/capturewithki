import { loadCollection, seedCollection, addCollectionItem, deleteCollectionItem, reorderCollection, updateCollectionItem } from './collection-store.js';
import { uploadImage } from './edit-image.js';
import { onEditingChange } from './auth.js';
import { setCurrentItem } from './edit-text.js';
import { showToast, hideToast } from './toast.js';

const COLLECTION = 'testimonials';
const FALLBACK = [
  { img: 'images/gallery-a.jpg', quote: 'She caught the ten seconds I was most afraid I’d forget.', who: 'Mailani & Josh' },
  { img: 'images/grid-03.jpg', quote: 'Calm the whole day. Our families still talk about how easy she made it.', who: 'Renée & Tomás' },
  { img: 'images/gallery-h.jpg', quote: 'We booked for the portfolio and stayed for the person.', who: 'Ava & Sam' },
  { img: 'images/grid-04.jpg', quote: 'It felt like hanging out with a friend who happened to have a camera.', who: 'Noa & Leilani' },
  { img: 'images/grid-07.jpg', quote: 'Every photo looks like a memory, not a pose.', who: 'Sarah & Michael' },
  { img: 'images/grid-12.jpg', quote: 'She made my anxious, awkward-in-photos self feel completely at ease.', who: 'Jenna & Chris' }
];

let items = [];
let usingFallback = true;
let index = 0;

const llImg = document.getElementById('llImg');
const llQuote = document.getElementById('llQuote');
const llWho = document.getElementById('llWho');
const llCount = document.getElementById('llCount');
const controls = document.getElementById('cmsLLControls');

// llImg's parent (.ll-media.frame) is already position:relative via .frame,
// so the reused .cms-image-overlay button lands on the photo without any
// extra positioning.
const llMedia = llImg.parentNode;
const changePhotoBtn = document.createElement('button');
changePhotoBtn.type = 'button';
changePhotoBtn.className = 'cms-image-overlay';
changePhotoBtn.textContent = 'Change photo';
changePhotoBtn.addEventListener('click', function (e) {
  e.preventDefault();
  e.stopPropagation();
  handleChangePhoto();
});
llMedia.appendChild(changePhotoBtn);

function renderLL() {
  if (!items.length) return;
  if (index >= items.length) index = 0;
  const d = items[index];
  setCurrentItem('testimonials', d.id);
  llImg.style.opacity = 0;
  llQuote.style.opacity = 0;
  llWho.style.opacity = 0;
  setTimeout(function () {
    llImg.src = d.img;
    llQuote.textContent = d.quote;
    llWho.textContent = d.who.toUpperCase();
    llCount.textContent = (index + 1) + ' / ' + items.length;
    llImg.style.opacity = 1;
    llQuote.style.opacity = 1;
    llWho.style.opacity = 1;
  }, 200);
}

async function refresh() {
  const loaded = await loadCollection(COLLECTION);
  if (loaded.length) {
    items = loaded;
    usingFallback = false;
  }
  if (index >= items.length) index = 0;
  renderLL();
}

async function ensureSeeded() {
  if (!usingFallback) return;
  await seedCollection(COLLECTION, FALLBACK);
  items = await loadCollection(COLLECTION);
  usingFallback = false;
  renderLL();
}

const form = document.getElementById('cmsLLForm');
const formQuote = document.getElementById('cmsLLQuote');
const formWho = document.getElementById('cmsLLWho');
const formPhoto = document.getElementById('cmsLLPhoto');
const formSave = document.getElementById('cmsLLSave');
const formCancel = document.getElementById('cmsLLCancel');
const formStatus = document.getElementById('cmsLLStatus');
const addBtn = document.getElementById('cmsLLAdd');

function setStatus(message, isError) {
  formStatus.textContent = message || '';
  formStatus.classList.toggle('cms-ll-error', !!isError);
}

function openForm() {
  form.hidden = false;
  addBtn.disabled = true;
  setStatus('');
  formQuote.focus();
}

function closeForm() {
  form.hidden = true;
  addBtn.disabled = false;
  formQuote.value = '';
  formWho.value = '';
  formPhoto.value = '';
  setStatus('');
}

// Every step reports. The old flow had six ways to quietly do nothing —
// a cancelled prompt, a blank answer, a dismissed picker, a picker that never
// opened, and a long silent upload — and no confirmation when it did work.
// That is what taught her to keep retrying.
async function submitForm() {
  const quote = formQuote.value.trim();
  const who = formWho.value.trim();
  const file = formPhoto.files[0];

  if (!quote) { setStatus('Please type the quote first.', true); formQuote.focus(); return; }
  if (!who) { setStatus('Please type the names first.', true); formWho.focus(); return; }
  if (!file) { setStatus('Please choose a photo first.', true); return; }

  formSave.disabled = true;
  formCancel.disabled = true;
  setStatus('Uploading the photo. On a phone this can take a while — please wait.');

  try {
    await ensureSeeded();
    const url = await uploadImage(file, 'testimonials');
    setStatus('Saving…');
    const newId = await addCollectionItem(COLLECTION, { img: url, quote: quote, who: who });

    items = await loadCollection(COLLECTION);
    usingFallback = false;
    // Find the new item by its id rather than assuming it sorted last. That
    // assumption is what showed her somebody else's testimonial and made a
    // successful add look like a failure.
    const at = items.findIndex(function (it) { return it.id === newId; });
    index = at >= 0 ? at : items.length - 1;
    renderLL();

    closeForm();
    showToast('Testimonial added');
  } catch (err) {
    // Leave the form open with her words still in it. Retyping a long quote
    // because the upload failed would be its own bug.
    setStatus('Could not add it: ' + (err && (err.code || err.message)) +
              '. Your words are still here — try again.', true);
  } finally {
    formSave.disabled = false;
    formCancel.disabled = false;
  }
}

async function handleDelete() {
  try {
    await ensureSeeded();
    if (items.length <= 1) {
      alert('At least one testimonial is required.');
      return;
    }
    if (!confirm('Delete this testimonial?')) return;
    await deleteCollectionItem(COLLECTION, items[index].id);
    index = 0;
    await refresh();
    showToast('Testimonial deleted');
  } catch (err) {
    alert('Could not delete that testimonial: ' + (err && (err.code || err.message)));
    await refresh();
  }
}

async function handleChangePhoto() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', async function () {
    const file = input.files[0];
    if (!file) return;
    try {
      await ensureSeeded();
      const id = items[index] && items[index].id;
      if (!id) return;
      showToast('Uploading the photo…', 0);
      const url = await uploadImage(file, 'testimonials');
      await updateCollectionItem('testimonials', id, { img: url });
      await refresh();
      showToast('Photo changed');
    } catch (err) {
      hideToast();
      alert('Could not change that photo: ' + (err && (err.code || err.message)));
      await refresh();
    }
  });
  input.click();
}

async function move(delta) {
  try {
    await ensureSeeded();
    if (items.length < 2) return;
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const ids = items.map(function (it) { return it.id; });
    const moved = ids.splice(index, 1)[0];
    ids.splice(target, 0, moved);
    await reorderCollection(COLLECTION, ids);
    items = await loadCollection(COLLECTION);
    index = target;
    renderLL();
  } catch (err) {
    alert('Could not move that testimonial: ' + (err && (err.code || err.message)));
    await refresh();
  }
}

export async function initTestimonials() {
  const loaded = await loadCollection(COLLECTION);
  if (loaded.length > 0) {
    items = loaded;
    usingFallback = false;
  } else {
    items = FALLBACK;
    usingFallback = true;
  }
  renderLL();

  document.getElementById('llPrev').addEventListener('click', function () {
    index = (index - 1 + items.length) % items.length;
    renderLL();
  });
  document.getElementById('llNext').addEventListener('click', function () {
    index = (index + 1) % items.length;
    renderLL();
  });
  document.addEventListener('cms:collection-item-saved', function (e) {
    if (e.detail && e.detail.collection === COLLECTION) refresh();
  });

  addBtn.addEventListener('click', openForm);
  formSave.addEventListener('click', submitForm);
  formCancel.addEventListener('click', closeForm);
  document.getElementById('cmsLLDelete').addEventListener('click', handleDelete);
  document.getElementById('cmsLLMoveLeft').addEventListener('click', function () { move(-1); });
  document.getElementById('cmsLLMoveRight').addEventListener('click', function () { move(1); });

  onEditingChange(async function (active) {
    if (active) {
      try {
        await ensureSeeded();
      } catch (err) {
        alert('Could not prepare testimonials for editing: ' + (err && (err.code || err.message)));
      }
    }
    controls.style.display = active ? 'flex' : 'none';
    if (!active) closeForm();
    changePhotoBtn.classList.toggle('cms-visible', active);
  });
}
