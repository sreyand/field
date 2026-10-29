/* Linked sources and batch organization extend the same canonical catalogue. */
(function () {
  'use strict';
  const desktop = window.FieldDesktop?.isDesktop;
  const expanded = new Set();
  const selected = new Set();
  const history = [];
  let filtered = [];
  let pageSize = 100;
  let synchronizing = false;
  let folderStates = new Map();
  let lastSyncError = '';
  const request = (method, params = {}) => window.FieldDesktop.request(method, params, 300000);
  const oldNavigate = navigate;
  navigate = function (next, id = null) {
    selected.clear(); pageSize = 100;
    if (next === 'field') ancestry(id).forEach(field => expanded.add(field.id));
    oldNavigate(next, id);
  };

  const oldSidebar = renderSidebar;
  renderSidebar = function () {
    oldSidebar();
    const children = new Map();
    for (const field of fields) {
      if (!children.has(field.parent)) children.set(field.parent, []);
      children.get(field.parent).push(field);
    }
    const tree = (parent, depth = 0) => (children.get(parent) || []).map(field => {
      const nested = children.has(field.id), open = expanded.has(field.id);
      return `<div class="tree-row" style="--depth:${depth};--field-color:${field.color}">${nested ? `<button class="tree-toggle" data-library-action="toggle-field" data-id="${field.id}" aria-label="${open ? 'Collapse' : 'Expand'} ${escapeHTML(field.name)}" aria-expanded="${open}" aria-controls="children-${field.id}">${icon(open ? 'down' : 'arrow')}</button>` : '<span class="tree-spacer"></span>'}<button class="tree-name ${currentField === field.id ? 'current' : ''}" data-action="open-field" data-id="${field.id}"><span class="field-dot"></span><span class="nav-field-name">${escapeHTML(field.name)}</span></button></div>${nested && open ? `<div id="children-${field.id}">${tree(field.id, depth + 1)}</div>` : ''}`;
    }).join('');
    $('#field-navigation').innerHTML = fields.length ? `<div class="section-label">Fields</div>${tree(null)}` : '';
  };

  const oldItem = renderItem;
  renderItem = item => `<div class="selectable-item ${selected.has(item.id) ? 'selected' : ''}"><input type="checkbox" class="item-select" data-select-item="${item.id}" aria-label="Select ${escapeHTML(item.title)}" ${selected.has(item.id) ? 'checked' : ''}>${oldItem(item)}</div>`;
  renderItems = function (list) {
    const visible = list.filter(item => itemFilter === 'all' || item.kind === itemFilter);
    filtered = visible.map(item => item.id);
    const toolbar = `<div class="bulk-toolbar">${visible.length ? `<label><input type="checkbox" data-select-all aria-label="Select all filtered items" ${visible.every(item => selected.has(item.id)) ? 'checked' : ''}>${selected.size ? `${selected.size} selected` : 'Select'}</label>` : ''}${selected.size ? '<button data-library-action="bulk-add">Add to fields</button><button data-library-action="bulk-remove">Remove from fields</button><button data-library-action="clear">Clear</button>' : ''}${history.length ? '<button data-library-action="undo">Undo</button>' : ''}</div>`;
    return (list.length ? renderFilters() : '') + (visible.length || history.length ? toolbar : '') + (visible.length ? `<div class="entry-list item-list">${visible.slice(0, pageSize).map(renderItem).join('')}</div>${visible.length > pageSize ? `<button class="button quiet" data-library-action="more">Show more (${visible.length - pageSize})</button>` : ''}` : `<div class="empty-state">${itemFilter === 'all' ? 'No items' : `No ${kinds[itemFilter].plural.toLowerCase()}`}</div>`);
  };

  const oldFields = renderFields;
  renderFields = function () {
    const html = oldFields();
    return desktop ? html.replace('<div class="header-actions">', '<div class="header-actions"><button class="button quiet" data-library-action="attach">Link folder</button>') : html;
  };
  const oldField = renderField;
  renderField = function () {
    const html = oldField(), field = byField(currentField);
    if (!field.folder) return html;
    const status = folderStates.get(field.id);
    return html.replace('</header>', `</header><div class="folder-source"><span title="${escapeHTML(field.folder.path)}">${icon('folder')}${escapeHTML(field.folder.path)}</span>${status && status.status !== 'available' ? `<span class="folder-status">${escapeHTML(status.message || status.status)}</span>` : ''}<button data-library-action="refresh">Refresh</button><button data-library-action="detach" data-id="${field.id}">Unlink</button></div>`);
  };
  const oldFieldActions = fieldQuickActions;
  fieldQuickActions = field => {
    const actions = oldFieldActions(field);
    if (desktop) actions.splice(2, 0, {label: field.folder ? 'Change folder' : 'Link folder', icon:icon('folder'),run:()=>attachFolder(field.id)});
    return actions;
  };

  function applyEnvelope(saved) {
    applyModel(new window.FieldModel.LibraryModel(saved.snapshot));
    libraryRevision = saved.revision;
    fileStates.clear();
    if (currentField && !byField(currentField)) {currentField = null; view = 'fields';}
    for (const id of selected) if (!byItem(id)) selected.delete(id);
    if (selectedEdge && !allEdges().some(edge=>edge.id===selectedEdge)) selectedEdge = null;
    if (saved.folders) folderStates = new Map(saved.folders.map(folder => [folder.fieldId, folder]));
    const detail = openItemId;
    render();
    if (detail && byItem(detail)) openItem(detail);
  }

  async function syncFolders(force = false) {
    if (!desktop || !isReady || isSaving || nativeBusy || syncingFiles || synchronizing || $('#modal').open || quickMenu.isOpen || selected.size || !fields.some(field=>field.folder)) return;
    synchronizing = true; nativeBusy = true;
    document.body.setAttribute('aria-busy', 'true');
    try {
      const saved = await request('folders.sync', {expectedRevision:libraryRevision,force});
      folderStates = new Map((saved.folders || []).map(folder=>[folder.fieldId,folder]));
      if (saved.revision !== libraryRevision) applyEnvelope(saved);
      else if (force || currentField && byField(currentField)?.folder) renderFileChanges();
      lastSyncError = '';
    } catch (error) {
      if (force || error.message !== lastSyncError) toast(error.message);
      lastSyncError = error.message;
    } finally { synchronizing = false; nativeBusy = false; document.body.removeAttribute('aria-busy'); }
  }
  setInterval(syncFolders, 5000);
  window.addEventListener('focus', () => syncFolders());

  async function attachFolder(fieldId = null) {
    if (!desktop || isSaving || nativeBusy) return;
    nativeBusy = true;
    try {
      const picked = await request('folders.pick');
      if (picked.cancelled) return;
      if (!fieldId) {
        const field = {id:uid('field'),name:picked.path.replace(/[\\/]+$/,'').split(/[\\/]/).pop() || picked.path,color:colors[0],parent:null};
        await saveMutation(model=>model.createField(field));
        fieldId = field.id;
      }
      document.body.setAttribute('aria-busy','true');
      const saved = await request('folders.attach',{fieldId,path:picked.path,expectedRevision:libraryRevision});
      applyEnvelope(saved);
      navigate('field',fieldId);
      const status = (saved.folders || []).find(folder=>folder.fieldId===fieldId);
      if (status && status.status !== 'available') toast(status.message || status.status);
    } catch(error) { toast(error.message); }
    finally { nativeBusy = false; document.body.removeAttribute('aria-busy'); }
  }

  function detachFolder(id) {
    showModal('Unlink folder?', `<p class="confirm-copy">Items stay in FIELD. Files stay on your PC.</p><div class="form-actions">${button('Cancel','close-modal','quiet')}<button class="button" id="confirm-unlink">Unlink</button></div><p class="form-error" id="unlink-error" role="alert"></p>`);
    $('#confirm-unlink').onclick = async () => {
      if (nativeBusy || isSaving) return;
      nativeBusy = true;
      try { applyEnvelope(await request('folders.detach',{fieldId:id,expectedRevision:libraryRevision}));closeModal(); }
      catch(error){$('#unlink-error').textContent=error.message;}
      finally{nativeBusy=false;}
    };
  }

  function bulk(mode) {
    const ids = [...selected];
    showModal(mode === 'add' ? 'Add to fields' : 'Remove from fields', `<form id="bulk-form"><div class="membership-options">${fields.map(field=>`<label class="membership-option"><input type="checkbox" value="${field.id}" name="field"><span>${escapeHTML(fieldPath(field.id))}</span></label>`).join('')}</div><p class="form-error" id="bulk-error" role="alert"></p><div class="form-actions">${button('Cancel','close-modal','quiet','type="button"')}<button class="button primary" type="submit">${mode==='add'?'Add':'Remove'}</button></div></form>`);
    $('#bulk-form').onsubmit = async event => {
      event.preventDefault();
      if (isSaving || nativeBusy) return;
      try {
        const targets = [...event.currentTarget.querySelectorAll('input:checked')].map(input=>input.value);
        const changes = await saveMutation(model=>model.bulkMemberships(ids,targets,mode),event.currentTarget);
        if (changes.some(change=>change.added.length || change.removed.length)) {history.push(changes);if(history.length>20)history.shift();}
        selected.clear();closeModal();render();toast('Fields updated');
      } catch(error){$('#bulk-error').textContent=error.message;}
    };
  }
  async function undo() {
    if (!history.length || isSaving || nativeBusy) return;
    try {await saveMutation(model=>model.undoMemberships(history.at(-1)));history.pop();renderFileChanges();toast('Organization restored');}
    catch(error){toast(saveError(error));}
  }

  document.addEventListener('change', event=>{
    if (!isReady || isSaving || nativeBusy) return;
    const node=event.target;
    if(node.matches('[data-select-item]')) {node.checked?selected.add(node.dataset.selectItem):selected.delete(node.dataset.selectItem);render();}
    if(node.matches('[data-select-all]')) {for(const id of filtered)node.checked?selected.add(id):selected.delete(id);render();}
  });
  document.addEventListener('click', event=>{
    if(event.target.closest('[data-action="filter"], [data-action="everything-mode"]')) {selected.clear();pageSize=100;render();}
    const node=event.target.closest('[data-library-action]');
    if(!node || !isReady || isSaving || nativeBusy)return;
    const action=node.dataset.libraryAction,id=node.dataset.id;
    if(action==='toggle-field'){expanded.has(id)?expanded.delete(id):expanded.add(id);renderSidebar();document.querySelector(`[data-library-action="toggle-field"][data-id="${id}"]`)?.focus();}
    if(action==='attach')attachFolder(id || null);
    if(action==='refresh')syncFolders(true);
    if(action==='detach')detachFolder(id);
    if(action==='bulk-add')bulk('add');
    if(action==='bulk-remove')bulk('remove');
    if(action==='undo')undo();
    if(action==='clear'){selected.clear();render();}
    if(action==='more'){pageSize+=100;render();}
  });
  document.addEventListener('keydown',event=>{
    if(!event.defaultPrevented && (event.ctrlKey || event.metaKey) && event.key.toLowerCase()==='z' && !$('#modal').open && !event.target.closest('input,textarea,[contenteditable]')){event.preventDefault();undo();}
  });

  // Indexed native search keeps the result view bounded as the catalogue grows.
  if (desktop) search = function () {
    showModal('Search','<input class="input search-input" id="search-query" placeholder="Search" aria-label="Search library" autocomplete="off"><div class="search-results" id="search-results"></div>');
    let generation=0,timer;
    async function update(){
      const current=++generation,query=$('#search-query').value;
      try{
        const {results}=await request('library.search',{query,limit:100});
        if(current!==generation || !$('#search-results'))return;
        $('#search-results').innerHTML=results.map(result=>`<button class="search-result" data-action="${result.kind==='field'?'search-field':'search-item'}" data-id="${escapeHTML(result.id)}">${icon(result.kind==='field'?'folder':kinds[byItem(result.id)?.kind]?.icon || 'file')}<div><strong>${escapeHTML(result.title)}</strong><small>${escapeHTML((result.preview || '').slice(0,150))}</small></div></button>`).join('') || '<div class="search-empty">No results</div>';
      }catch(error){if($('#search-results'))$('#search-results').textContent=error.message;}
    }
    $('#search-query').oninput=()=>{clearTimeout(timer);timer=setTimeout(update,150);};update();
  };

  const oldLibrary=library;
  library=function(){oldLibrary();if(desktop){const button=document.createElement('button');button.className='button secondary';button.textContent='Backups';button.onclick=backups;$('.library-actions').append(button);}};
  async function backups(){
    showModal('Backups','<div id="backup-list">Loading…</div><p id="backup-error" class="form-error" role="alert"></p>');
    try{
      const result=await request('library.backups');if(!$('#backup-list'))return;
      $('#backup-list').innerHTML=result.backups.map(backup=>`<div class="library-row"><span>${escapeHTML(new Date(backup.createdUtc).toLocaleString())}</span><button class="button quiet compact" data-backup="${escapeHTML(backup.fileName)}">Restore</button></div>`).join('') || '<div class="blank-message">No backups yet</div>';
      document.querySelectorAll('[data-backup]').forEach(node=>node.onclick=()=>confirmRestore(node.dataset.backup));
    }catch(error){if($('#backup-error'))$('#backup-error').textContent=error.message;}
  }
  function confirmRestore(fileName){
    showModal('Restore backup?',`<p class="confirm-copy">This restores FIELD's catalogue. Current organization is backed up first. PC files stay untouched.</p><div class="form-actions">${button('Cancel','close-modal','quiet')}<button class="button" id="restore-backup">Restore</button></div><p id="restore-error" class="form-error" role="alert"></p>`);
    $('#restore-backup').onclick=async()=>{
      if(nativeBusy || isSaving)return;
      nativeBusy=true;
      try{applyEnvelope(await request('library.restore',{fileName,expectedRevision:libraryRevision}));history.length=0;selected.clear();closeModal();navigate('fields');toast('Catalogue restored');}
      catch(error){$('#restore-error').textContent=error.message;}
      finally{nativeBusy=false;}
    };
  }
})();
