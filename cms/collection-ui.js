export function makeCollectionEditable(options) {
  const onAdd = options.onAdd;
  const onDelete = options.onDelete;
  const onReorder = options.onReorder;
  let dragEl = null;

  function attachTile(tile, itemId) {
    tile.setAttribute('draggable', 'true');
    tile.dataset.cmsItemId = itemId;
    tile.classList.add('cms-collection-tile');

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

    tile.addEventListener('dragstart', function () {
      dragEl = tile;
      tile.classList.add('cms-dragging');
    });
    tile.addEventListener('dragend', function () {
      tile.classList.remove('cms-dragging');
      dragEl = null;
      const container = tile.parentNode;
      const orderedIds = Array.prototype.slice
        .call(container.children)
        .filter(function (el) { return el.dataset && el.dataset.cmsItemId; })
        .map(function (el) { return el.dataset.cmsItemId; });
      onReorder(orderedIds);
    });
    tile.addEventListener('dragover', function (e) {
      e.preventDefault();
      if (!dragEl || dragEl === tile) return;
      const rect = tile.getBoundingClientRect();
      const before = (e.clientX - rect.left) < rect.width / 2;
      tile.parentNode.insertBefore(dragEl, before ? tile : tile.nextSibling);
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
