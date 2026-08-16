import { loadCollection, seedCollection, addCollectionItem, deleteCollectionItem, reorderCollection, updateCollectionItem } from './collection-store.js';
import { makeCollectionEditable } from './collection-ui.js';
import { uploadImage } from './edit-image.js';
import { onEditingChange } from './auth.js';
import { showWhenLoaded } from './reveal.js';

const COLLECTION = 'filmstripShots';
const FALLBACK = [
  { src: 'images/gallery-a.jpg' },
  { src: 'images/gallery-b.jpg' },
  { src: 'images/gallery-c.jpg' },
  { src: 'images/gallery-d.jpg' },
  { src: 'images/gallery-e.jpg' },
  { src: 'images/gallery-f.jpg' },
  { src: 'images/gallery-g.jpg' },
  { src: 'images/gallery-h.jpg' },
  { src: 'images/gallery-i.jpg' }
];

let items = [];
let usingFallback = true;

const track = document.getElementById('filmstripTrack');

// Exactly one instance: the drag state lives in its closure and must be
// shared by every tile, or dragover on a different tile sees a null dragEl.
const ui = makeCollectionEditable({
  onAdd: handleAdd,
  onDelete: handleDelete,
  onReorder: handleReorder,
  onSwap: handleSwap
});

function render() {
  track.innerHTML = '';
  if (!items.length) return;
  // Duplicated once so the auto-scroll can loop seamlessly. Only the first
  // copy gets collection UI attached — the aria-hidden duplicates are purely
  // visual and must never carry delete/swap controls or drag listeners.
  items.concat(items).forEach(function (item, i) {
    const isDup = i >= items.length;
    const frame = document.createElement('div');
    frame.className = 'frame marked';
    if (isDup) frame.setAttribute('aria-hidden', 'true');
    frame.innerHTML = '<img alt="">';
    showWhenLoaded(frame.querySelector('img'), item.src);
    track.appendChild(frame);
    if (!usingFallback && !isDup) ui.attachTile(frame, item.id);
  });

  if (!usingFallback) track.appendChild(ui.buildAddTile());
}

async function refresh() {
  items = await loadCollection(COLLECTION);
  render();
}

async function ensureSeeded() {
  if (!usingFallback) return;
  await seedCollection(COLLECTION, FALLBACK);
  items = await loadCollection(COLLECTION);
  usingFallback = false;
  render();
}

async function handleAdd() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', async function () {
    const file = input.files[0];
    if (!file) return;
    try {
      await ensureSeeded();
      const url = await uploadImage(file, 'filmstripShots');
      await addCollectionItem(COLLECTION, { src: url });
      await refresh();
    } catch (err) {
      alert('Could not add that photo: ' + (err && (err.code || err.message)));
      await refresh();
    }
  });
  input.click();
}

async function handleDelete(id) {
  try {
    await deleteCollectionItem(COLLECTION, id);
    await refresh();
  } catch (err) {
    alert('Could not delete that photo: ' + (err && (err.code || err.message)));
    await refresh();
  }
}

async function handleReorder(orderedIds) {
  try {
    await reorderCollection(COLLECTION, orderedIds);
    await refresh();
  } catch (err) {
    alert('Could not save the new order: ' + (err && (err.code || err.message)));
    await refresh();
  }
}

function handleSwap(id) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', async function () {
    const file = input.files[0];
    if (!file) return;
    try {
      const url = await uploadImage(file, 'filmstripShots');
      await updateCollectionItem(COLLECTION, id, { src: url });
      await refresh();
    } catch (err) {
      alert('Could not swap that photo: ' + (err && (err.code || err.message)));
      await refresh();
    }
  });
  input.click();
}

export async function initFilmstrip() {
  const loaded = await loadCollection(COLLECTION);
  if (loaded.length > 0) {
    items = loaded;
    usingFallback = false;
  } else {
    items = FALLBACK;
    usingFallback = true;
  }
  render();

  onEditingChange(async function (active) {
    if (active) {
      try {
        await ensureSeeded();
      } catch (err) {
        alert('Could not prepare the filmstrip for editing: ' + (err && (err.code || err.message)));
      }
    }
    track.classList.toggle('cms-editmode', active);
  });
}
