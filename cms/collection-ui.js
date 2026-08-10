export function makeCollectionEditable(options) {
  const onAdd = options.onAdd;
  const onDelete = options.onDelete;
  const onReorder = options.onReorder;
  let dragEl = null;

  function orderedIdsOf(container) {
    return Array.prototype.slice
      .call(container.children)
      .filter(function (el) { return el.dataset && el.dataset.cmsItemId; })
      .map(function (el) { return el.dataset.cmsItemId; });
  }

  function attachTile(tile, itemId) {
    // Callers re-render after every mutation; guard against a retained node
    // getting a second delete button and a second set of drag listeners.
    if (tile.dataset.cmsAttached === '1') return;
    tile.dataset.cmsAttached = '1';

    tile.setAttribute('draggable', 'true');
    tile.dataset.cmsItemId = itemId;
    tile.classList.add('cms-collection-tile');

    // Images are draggable by default, which would hijack the tile drag.
    tile.querySelectorAll('img').forEach(function (img) {
      img.setAttribute('draggable', 'false');
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'cms-collection-delete';
    del.textContent = '×';
    del.setAttribute('aria-label', 'Delete');
    del.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (confirm('Delete this item?')) onDelete(itemId);
    });
    tile.appendChild(del);

    tile.addEventListener('dragstart', function (e) {
      dragEl = tile;
      tile.classList.add('cms-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        // Firefox refuses to start a drag session unless data is set.
        e.dataTransfer.setData('text/plain', itemId);
      }
    });

    tile.addEventListener('dragover', function (e) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      if (!dragEl || dragEl === tile) return;
      if (dragEl.parentNode !== tile.parentNode) return;

      // Layout-agnostic: whichever axis the pointer sits more decisively
      // off-centre on decides before/after, so this works for a horizontal
      // row, a wrapped grid, and a vertical stack alike.
      const rect = tile.getBoundingClientRect();
      const dx = (e.clientX - (rect.left + rect.width / 2)) / rect.width;
      const dy = (e.clientY - (rect.top + rect.height / 2)) / rect.height;
      const before = (Math.abs(dx) > Math.abs(dy) ? dx : dy) < 0;

      const ref = before ? tile : tile.nextSibling;
      // Skip redundant moves; dragover fires continuously and re-inserting
      // on every event makes a wrapped grid flicker.
      if (ref === dragEl || dragEl.nextSibling === ref) return;
      tile.parentNode.insertBefore(dragEl, ref);
    });

    tile.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
    });

    tile.addEventListener('dragend', function () {
      tile.classList.remove('cms-dragging');
      dragEl = null;
      const container = tile.parentNode;
      if (!container) return;
      onReorder(orderedIdsOf(container));
    });
  }

  function buildAddTile() {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'cms-collection-add';
    tile.textContent = '+ Add';
    tile.addEventListener('click', onAdd);
    return tile;
  }

  return { attachTile: attachTile, buildAddTile: buildAddTile };
}
