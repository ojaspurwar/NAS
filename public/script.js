document.addEventListener('DOMContentLoaded', () => {
    // Top elements
    const fileInput = document.getElementById('file-input');
    const folderInput = document.getElementById('folder-input');
    const uploadFileBtn = document.getElementById('upload-file-btn');
    const uploadFolderBtn = document.getElementById('upload-folder-btn');
    const fileList = document.getElementById('file-list');
    const refreshBtn = document.getElementById('refresh-btn');
    const newFolderBtn = document.getElementById('new-folder-btn');
    const breadcrumb = document.getElementById('breadcrumb');
    const progressContainer = document.getElementById('progress-container');
    const progressBar = document.getElementById('progress-bar');
    const searchInput = document.getElementById('search-input');
    const sortSelect = document.getElementById('sort-select');

    // UI elements
    const loginOverlay = document.getElementById('login-overlay');
    const loginBtn = document.getElementById('login-btn');
    const passwordInput = document.getElementById('password-input');
    const loginError = document.getElementById('login-error');
    const appContent = document.getElementById('app-content');
    
    const storageInfo = document.getElementById('storage-info');
    const storageUsedText = document.getElementById('storage-used-text');
    const storageFreeText = document.getElementById('storage-free-text');
    const storageBar = document.getElementById('storage-bar');

    // Header buttons
    const mobileMenuBtn = document.getElementById('mobile-menu-btn');
    const pcHealthBtn = document.getElementById('pc-health-btn');
    const trashBtn = document.getElementById('trash-btn');
    const hiddenBtn = document.getElementById('hidden-btn');
    
    // Health Modal elements
    const healthModal = document.getElementById('health-modal');
    const healthCloseBtn = document.getElementById('health-close-btn');
    const healthCpu = document.getElementById('health-cpu');
    const healthRam = document.getElementById('health-ram');
    const healthUptime = document.getElementById('health-uptime');

    // Multi-select elements
    const multiActionBar = document.getElementById('multi-action-bar');
    const selectedCountSpan = document.getElementById('selected-count');
    const multiDownloadBtn = document.getElementById('multi-download-btn');
    const multiMoveBtn = document.getElementById('multi-move-btn');
    const multiDeleteBtn = document.getElementById('multi-delete-btn');
    const multiCancelBtn = document.getElementById('multi-cancel-btn');

    // Modal elements
    const appModal = document.getElementById('app-modal');
    const modalTitle = document.getElementById('modal-title');
    const modalDesc = document.getElementById('modal-desc');
    const modalInput = document.getElementById('modal-input');
    const modalCancel = document.getElementById('modal-cancel');
    const modalConfirm = document.getElementById('modal-confirm');

    // Lightbox elements
    const lightboxOverlay = document.getElementById('lightbox-overlay');
    const lightboxClose = document.getElementById('lightbox-close');
    const lightboxImg = document.getElementById('lightbox-img');
    const lightboxVideo = document.getElementById('lightbox-video');
    const lightboxAudio = document.getElementById('lightbox-audio');
    const lightboxPdf = document.getElementById('lightbox-pdf');

    let currentPath = '';
    let authToken = localStorage.getItem('nas_token') || '';
    let currentFiles = [];
    let selectedFiles = new Set();
    let modalConfirmCallback = null;

    // --- Modal Logic ---
    function showModal(title, desc, placeholder, initialValue, onConfirm) {
        modalTitle.innerText = title;
        modalDesc.innerText = desc;
        modalInput.placeholder = placeholder || '';
        modalInput.value = initialValue || '';
        modalConfirmCallback = onConfirm;
        appModal.style.display = 'flex';
        modalInput.focus();
    }
    
    function hideModal() {
        appModal.style.display = 'none';
        modalConfirmCallback = null;
        modalInput.type = 'text';
    }

    modalCancel.addEventListener('click', hideModal);
    modalConfirm.addEventListener('click', () => {
        if (modalConfirmCallback) modalConfirmCallback(modalInput.value);
        hideModal();
    });
    modalInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') modalConfirm.click();
    });

    // --- Lightbox Logic ---
    function showLightbox(file, ext) {
        const streamUrl = `/api/stream?path=${encodeURIComponent(currentPath ? currentPath + '/' + file.name : file.name)}&token=${authToken}`;
        lightboxImg.style.display = 'none';
        lightboxVideo.style.display = 'none';
        lightboxAudio.style.display = 'none';
        lightboxPdf.style.display = 'none';
        lightboxVideo.pause();
        lightboxAudio.pause();

        if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'].includes(ext)) {
            lightboxImg.src = streamUrl;
            lightboxImg.style.display = 'block';
        } else if (['mp4', 'webm', 'ogg', 'mov', 'mkv'].includes(ext)) {
            lightboxVideo.src = streamUrl;
            lightboxVideo.style.display = 'block';
            lightboxVideo.play();
        } else if (['mp3', 'wav'].includes(ext)) {
            lightboxAudio.src = streamUrl;
            lightboxAudio.style.display = 'block';
            lightboxAudio.play();
        } else if (ext === 'pdf') {
            lightboxPdf.src = streamUrl;
            lightboxPdf.style.display = 'block';
            lightboxPdf.style.width = '80vw';
        }
        lightboxOverlay.style.display = 'flex';
    }

    lightboxClose.addEventListener('click', () => {
        lightboxOverlay.style.display = 'none';
        lightboxVideo.pause();
        lightboxAudio.pause();
        lightboxVideo.src = '';
        lightboxAudio.src = '';
        lightboxImg.src = '';
        lightboxPdf.src = '';
    });

    // --- Health Logic ---
    async function showHealthModal() {
        try {
            const response = await fetch('/api/health', { headers: getHeaders() });
            if (response.ok) {
                const data = await response.json();
                healthCpu.innerText = `${data.cpuUsage}%`;
                healthRam.innerText = `${formatBytes(data.usedMem)} / ${formatBytes(data.totalMem)}`;
                healthUptime.innerText = `${(data.uptime / 3600).toFixed(1)} hrs`;
                healthModal.style.display = 'flex';
            }
        } catch(e) { console.error('Failed to get health'); }
    }
    
    mobileMenuBtn.addEventListener('click', showHealthModal);
    pcHealthBtn.addEventListener('click', showHealthModal);
    healthCloseBtn.addEventListener('click', () => healthModal.style.display = 'none');

    // --- Trash & Hidden Logic ---
    trashBtn.addEventListener('click', () => {
        window.goToFolder('.trash');
    });

    hiddenBtn.addEventListener('click', () => {
        modalInput.type = 'password';
        showModal('Hidden Files', 'Enter PIN to access hidden files:', 'PIN', '', (pwd) => {
            if (pwd === "4054") {
                window.goToFolder('.hidden');
            } else {
                alert("Incorrect PIN!");
            }
        });
    });

    // --- Core Logic ---
    async function fetchStorageInfo() {
        try {
            const response = await fetch('/api/storage', {
                headers: { 'Authorization': `Bearer ${authToken}` }
            });
            if (response.ok) {
                const data = await response.json();
                storageInfo.style.display = 'block';
                storageUsedText.innerText = formatBytes(data.used, 1);
                storageFreeText.innerText = formatBytes(data.free, 1);
                const percent = Math.min(100, Math.round((data.used / data.total) * 100));
                storageBar.style.width = `${percent}%`;
                if (percent > 90) storageBar.style.background = 'linear-gradient(90deg, var(--danger), #991b1b)';
                else storageBar.style.background = 'linear-gradient(90deg, var(--primary), var(--secondary))';
            }
        } catch (error) { console.error('Error fetching storage:', error); }
    }

    function getHeaders() {
        return {
            'Authorization': `Bearer ${authToken}`,
            'Content-Type': 'application/json'
        };
    }

    function handleAuthError(res) {
        if (res.status === 401) {
            appContent.style.display = 'none';
            loginOverlay.style.display = 'flex';
            localStorage.removeItem('nas_token');
            authToken = '';
            return true;
        }
        return false;
    }

    if (authToken) {
        loginOverlay.style.display = 'none';
        appContent.style.display = 'flex';
        fetchFiles();
    }

    loginBtn.addEventListener('click', async () => {
        authToken = passwordInput.value;
        localStorage.setItem('nas_token', authToken);
        const res = await fetch(`/api/files?path=`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        if (res.status === 401) {
            loginError.style.display = 'block';
            localStorage.removeItem('nas_token');
            authToken = '';
        } else {
            loginError.style.display = 'none';
            loginOverlay.style.display = 'none';
            appContent.style.display = 'flex';
            fetchFiles();
        }
    });

    passwordInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') loginBtn.click(); });

    refreshBtn.addEventListener('click', () => {
        searchInput.value = '';
        fetchFiles();
    });

    sortSelect.addEventListener('change', () => {
        renderFileList(currentFiles, false);
    });

    // Search functionality
    let searchTimeout = null;
    searchInput.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        const query = e.target.value.trim();
        searchTimeout = setTimeout(() => {
            if (query === '') fetchFiles();
            else performSearch(query);
        }, 300);
    });

    async function performSearch(query) {
        breadcrumb.innerText = `Search Results for "${query}"`;
        fileList.innerHTML = '<div class="loading">Searching...</div>';
        try {
            const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { headers: { 'Authorization': `Bearer ${authToken}` } });
            if (handleAuthError(response)) return;
            const files = await response.json();
            currentFiles = files;
            if (files.length === 0) {
                fileList.innerHTML = '<div class="empty-state">No files found matching your search.</div>';
                return;
            }
            renderFileList(files, true);
        } catch (err) {
            console.error('Search error:', err);
            fileList.innerHTML = '<div class="empty-state">Search failed</div>';
        }
    }

    newFolderBtn.addEventListener('click', () => {
        showModal('Create Folder', 'Enter the name of the new folder:', 'Folder name', '', async (folderName) => {
            if (!folderName) return;
            const newPath = currentPath ? `${currentPath}/${folderName}` : folderName;
            try {
                const response = await fetch('/api/folders', {
                    method: 'POST',
                    headers: getHeaders(),
                    body: JSON.stringify({ path: newPath })
                });
                if (handleAuthError(response)) return;
                if (response.ok) fetchFiles();
                else { const data = await response.json(); alert(data.error || 'Failed to create folder'); }
            } catch (error) { console.error('Error creating folder:', error); }
        });
    });

    breadcrumb.addEventListener('click', () => {
        if (currentPath !== '') { currentPath = ''; fetchFiles(); }
    });

    // Upload logic
    uploadFileBtn.addEventListener('click', () => fileInput.click());
    uploadFolderBtn.addEventListener('click', () => folderInput.click());

    fileInput.addEventListener('change', (e) => { 
        if (e.target.files.length > 0) handleUpload(e.target.files); 
    });

    folderInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            const filesToUpload = [];
            for (let i = 0; i < e.target.files.length; i++) {
                const f = e.target.files[i];
                // webkitRelativePath contains the full relative path
                let destPath = currentPath;
                if (f.webkitRelativePath) {
                    const parts = f.webkitRelativePath.split('/');
                    parts.pop(); // remove file name
                    const relativeDir = parts.join('/');
                    destPath = currentPath ? `${currentPath}/${relativeDir}` : relativeDir;
                }
                filesToUpload.push({ file: f, path: destPath });
            }
            handleUpload(filesToUpload);
        }
    });



    async function handleUpload(itemsArray) {
        progressContainer.style.display = 'block';
        let successCount = 0;
        for (let i = 0; i < itemsArray.length; i++) {
            const item = itemsArray[i];
            const file = item.file || item;
            const destPath = item.path !== undefined ? item.path : currentPath;
            const data = new FormData();
            data.append('path', destPath);
            data.append('file', file);
            try {
                const response = await fetch('/api/upload', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${authToken}` },
                    body: data
                });
                if (handleAuthError(response)) return;
                if (response.ok) successCount++;
                progressBar.style.width = `${Math.round(((i + 1) / itemsArray.length) * 100)}%`;
            } catch (err) { console.error('Upload error:', err); }
        }
        setTimeout(() => {
            progressContainer.style.display = 'none';
            progressBar.style.width = '0%';
            fileInput.value = '';
            folderInput.value = '';
            if (successCount > 0) fetchFiles();
        }, 1000);
    }

    async function fetchFiles() {
        fetchStorageInfo();
        selectedFiles.clear();
        updateMultiActionBar();
        
        breadcrumb.innerText = currentPath === '' ? 'Home' : `Home / ${currentPath.split('/').join(' / ')}`;
        try {
            const response = await fetch(`/api/files?path=${encodeURIComponent(currentPath)}`, {
                headers: { 'Authorization': `Bearer ${authToken}` }
            });
            if (handleAuthError(response)) return;
            const files = await response.json();
            currentFiles = files;
            
            if (files.length === 0) {
                fileList.innerHTML = currentPath === '' ? '<div class="empty-state">No files yet. Upload something!</div>' : '<div class="empty-state">This folder is empty.</div>';
                
                // Add Up button if empty but not root
                if (currentPath !== '') {
                    const upItem = document.createElement('div');
                    upItem.className = 'file-item';
                    upItem.style.cursor = 'pointer';
                    upItem.innerHTML = `<div class="file-info"><i class="fa-solid fa-level-up-alt file-icon"></i><div class="file-details"><span class="file-name" style="color: var(--primary);">.. (Go Up)</span></div></div>`;
                    upItem.addEventListener('click', () => {
                        const parts = currentPath.split('/'); parts.pop(); currentPath = parts.join('/'); fetchFiles();
                    });
                    fileList.prepend(upItem);
                }
                
                // Add Empty Trash button if in trash
                if (currentPath === '.trash') {
                    const emptyTrashBtn = document.createElement('button');
                    emptyTrashBtn.className = 'btn-confirm';
                    emptyTrashBtn.style.margin = '20px auto';
                    emptyTrashBtn.style.display = 'block';
                    emptyTrashBtn.innerText = 'Empty Recycle Bin';
                    emptyTrashBtn.onclick = async () => {
                        if(confirm('Permanently delete all items in trash?')) {
                            await fetch('/api/trash/empty', { method: 'DELETE', headers: getHeaders() });
                            fetchFiles();
                        }
                    };
                    fileList.appendChild(emptyTrashBtn);
                }
                return;
            }
            renderFileList(currentFiles, false);
        } catch (error) {
            console.error('Error fetching files:', error);
            fileList.innerHTML = '<div class="empty-state">Failed to load files</div>';
        }
    }

    function sortFiles(files) {
        const sortMode = sortSelect.value;
        return [...files].sort((a, b) => {
            // Folders usually first
            if (a.isDirectory && !b.isDirectory) return -1;
            if (!a.isDirectory && b.isDirectory) return 1;
            
            if (sortMode === 'name_asc') return a.name.localeCompare(b.name);
            if (sortMode === 'name_desc') return b.name.localeCompare(a.name);
            if (sortMode === 'size_desc') return (b.size || 0) - (a.size || 0);
            if (sortMode === 'size_asc') return (a.size || 0) - (b.size || 0);
            if (sortMode === 'date_desc') return new Date(b.createdAt) - new Date(a.createdAt);
            if (sortMode === 'date_asc') return new Date(a.createdAt) - new Date(b.createdAt);
            return 0;
        });
    }

    function renderFileList(files, isSearch) {
        fileList.innerHTML = '';
        
        if (!isSearch && currentPath !== '') {
            const upItem = document.createElement('div');
            upItem.className = 'file-item';
            upItem.style.cursor = 'pointer';
            upItem.innerHTML = `<div class="file-info"><i class="fa-solid fa-level-up-alt file-icon"></i><div class="file-details"><span class="file-name" style="color: var(--primary);">.. (Go Up)</span></div></div>`;
            upItem.addEventListener('click', () => {
                const parts = currentPath.split('/'); parts.pop(); currentPath = parts.join('/'); fetchFiles();
            });
            fileList.appendChild(upItem);
        }

        if (currentPath === '.trash' && files.length > 0) {
            const emptyTrashBtn = document.createElement('button');
            emptyTrashBtn.className = 'btn-confirm';
            emptyTrashBtn.style.margin = '10px auto 20px auto';
            emptyTrashBtn.style.display = 'block';
            emptyTrashBtn.innerText = 'Empty Recycle Bin';
            emptyTrashBtn.onclick = async () => {
                if(confirm('Permanently delete all items in trash?')) {
                    await fetch('/api/trash/empty', { method: 'DELETE', headers: getHeaders() });
                    fetchFiles();
                }
            };
            fileList.appendChild(emptyTrashBtn);
        }

        const sortedFiles = sortFiles(files);

        sortedFiles.forEach(file => {
            const item = document.createElement('div');
            item.className = 'file-item';
            const date = new Date(file.createdAt).toLocaleString();
            const filePath = isSearch ? file.path : (currentPath ? `${currentPath}/${file.name}` : file.name);
            const displayName = isSearch ? filePath : file.name;
            const ext = file.name.split('.').pop().toLowerCase();
            const isHiddenFolder = currentPath.startsWith('.hidden');
            
            // Checkbox logic
            const checkboxHtml = `<input type="checkbox" class="file-checkbox" data-path="${filePath.replace(/"/g, '&quot;')}" ${selectedFiles.has(filePath) ? 'checked' : ''}>`;
            
            let fileIconHtml = '';
            let onClickAction = '';
            
            if (file.isDirectory) {
                fileIconHtml = `<i class="fa-solid fa-folder file-icon" style="color: var(--primary);"></i>`;
                onClickAction = isSearch ? `window.goToFolder('${filePath.replace(/'/g, "\\'")}')` : `window.navigateFolder('${file.name.replace(/'/g, "\\'")}')`;
            } else {
                let iconClass = 'fa-file';
                const mediaExts = ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'mp4', 'webm', 'ogg', 'mov', 'mkv', 'mp3', 'wav', 'pdf'];
                if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'].includes(ext)) iconClass = 'fa-file-image';
                else if (['mp4', 'avi', 'mov', 'mkv', 'webm'].includes(ext)) iconClass = 'fa-file-video';
                else if (['mp3', 'wav', 'ogg'].includes(ext)) iconClass = 'fa-file-audio';
                else if (['pdf'].includes(ext)) iconClass = 'fa-file-pdf';
                else if (['zip', 'rar', '7z'].includes(ext)) iconClass = 'fa-file-zipper';
                else if (['doc', 'docx'].includes(ext)) iconClass = 'fa-file-word';
                else if (['xls', 'xlsx'].includes(ext)) iconClass = 'fa-file-excel';
                else if (['txt', 'md', 'json', 'csv'].includes(ext)) iconClass = 'fa-file-lines';
                
                if (mediaExts.includes(ext)) {
                    fileIconHtml = `<i class="fa-solid ${iconClass} file-icon"></i>`;
                } else {
                    fileIconHtml = `<i class="fa-solid ${iconClass} file-icon"></i>`;
                }
            }
            
            const size = file.isDirectory ? '' : formatBytes(file.size);
            
            item.innerHTML = `
                <div class="file-info" style="flex:1; min-width:0;">
                    ${checkboxHtml}
                    <div style="display:flex; align-items:center; cursor: ${file.isDirectory || ['jpg','jpeg','png','gif','mp4','webm','mp3','wav','pdf'].includes(ext) ? 'pointer' : 'default'}; flex:1; min-width:0;" class="clickable-area">
                        ${fileIconHtml}
                        <div class="file-details" style="margin-left: 12px; flex:1; min-width:0;">
                            <span class="file-name" title="${displayName}">${displayName}</span>
                            <span class="file-meta">${file.isDirectory ? 'Folder' : size} • ${date}</span>
                        </div>
                    </div>
                </div>
                <div class="file-actions" style="flex-shrink:0;">
                    <button class="action-btn hide-file-btn" title="${isHiddenFolder ? 'Unhide' : 'Hide'}"><i class="fa-solid ${isHiddenFolder ? 'fa-eye' : 'fa-eye-slash'}"></i></button>
                    <button class="action-btn rename-btn" title="Rename"><i class="fa-solid fa-pen-to-square"></i></button>
                    ${file.isDirectory ? 
                        `<a href="/api/download-zip?path=${encodeURIComponent(filePath)}&token=${encodeURIComponent(authToken)}" class="action-btn download" title="Download Zip"><i class="fa-solid fa-file-zipper"></i></a>` : 
                        `<a href="/api/download?path=${encodeURIComponent(filePath)}&token=${encodeURIComponent(authToken)}" class="action-btn download" download="${file.name}" title="Download"><i class="fa-solid fa-download"></i></a>`}
                    <button class="action-btn delete" onclick="deleteItem('${filePath.replace(/'/g, "\\'")}')" title="Delete">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            `;
            
            // Events
            const hideFileBtn = item.querySelector('.hide-file-btn');
            hideFileBtn.addEventListener('click', async () => {
                const newParentPath = isHiddenFolder ? '' : '.hidden';
                try {
                    const res = await fetch('/api/move', {
                        method: 'PUT',
                        headers: getHeaders(),
                        body: JSON.stringify({ oldPath: filePath, newParentPath })
                    });
                    if (res.ok) fetchFiles();
                    else { const data = await res.json(); alert(data.error || 'Action failed'); }
                } catch(e) { console.error(e); }
            });

            const checkbox = item.querySelector('.file-checkbox');
            checkbox.addEventListener('change', (e) => {
                if (e.target.checked) selectedFiles.add(filePath);
                else selectedFiles.delete(filePath);
                updateMultiActionBar();
            });

            const clickableArea = item.querySelector('.clickable-area');
            clickableArea.addEventListener('click', () => {
                if (file.isDirectory) {
                    isSearch ? window.goToFolder(filePath) : window.navigateFolder(file.name);
                } else {
                    if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'mp4', 'webm', 'ogg', 'mov', 'mkv', 'mp3', 'wav', 'pdf'].includes(ext)) {
                        showLightbox(file, ext);
                    }
                }
            });

            const renameBtn = item.querySelector('.rename-btn');
            renameBtn.addEventListener('click', () => {
                showModal('Rename', `Enter new name for ${file.name}:`, 'New name', file.name, async (newName) => {
                    if (!newName || newName === file.name) return;
                    try {
                        const response = await fetch('/api/rename', {
                            method: 'PUT',
                            headers: getHeaders(),
                            body: JSON.stringify({ oldPath: filePath, newName })
                        });
                        if (response.ok) fetchFiles();
                        else { const data = await response.json(); alert(data.error || 'Rename failed'); }
                    } catch (e) { console.error(e); }
                });
            });

            fileList.appendChild(item);
        });
    }

    function updateMultiActionBar() {
        if (selectedFiles.size > 0) {
            multiActionBar.style.display = 'flex';
            selectedCountSpan.innerText = `${selectedFiles.size} selected`;
            multiDownloadBtn.style.display = 'none'; // Hide multi-download to avoid complexity
        } else {
            multiActionBar.style.display = 'none';
        }
    }

    multiCancelBtn.addEventListener('click', () => {
        selectedFiles.clear();
        renderFileList(currentFiles, false);
        updateMultiActionBar();
    });

    multiDeleteBtn.addEventListener('click', async () => {
        const isTrash = currentPath.startsWith('.trash');
        if (!confirm(isTrash ? `Permanently delete ${selectedFiles.size} items?` : `Move ${selectedFiles.size} items to Recycle Bin?`)) return;
        const paths = Array.from(selectedFiles);
        let success = true;
        for (const p of paths) {
            try {
                const res = await fetch(`/api/files?path=${encodeURIComponent(p)}&permanent=${isTrash}`, { method: 'DELETE', headers: getHeaders() });
                if (!res.ok) success = false;
            } catch(e) { success = false; }
        }
        if (!success) alert("Some items failed to delete.");
        fetchFiles();
    });

    multiMoveBtn.addEventListener('click', () => {
        showModal('Move Items', 'Enter destination folder path (leave empty for root):', 'e.g., Photos/Vacation', '', async (newParentPath) => {
            const paths = Array.from(selectedFiles);
            let success = true;
            for (const p of paths) {
                try {
                    const res = await fetch('/api/move', {
                        method: 'PUT',
                        headers: getHeaders(),
                        body: JSON.stringify({ oldPath: p, newParentPath })
                    });
                    if (!res.ok) success = false;
                } catch(e) { success = false; }
            }
            if (!success) alert("Some items failed to move.");
            fetchFiles();
        });
    });

    window.goToFolder = function(folderPath) { searchInput.value = ''; currentPath = folderPath; fetchFiles(); };
    window.navigateFolder = function(folderName) { currentPath = currentPath ? `${currentPath}/${folderName}` : folderName; fetchFiles(); };
    window.deleteItem = async function(path) {
        const isTrash = path.startsWith('.trash');
        if (!confirm(isTrash ? `Are you sure you want to PERMANENTLY delete ${path}?` : `Move ${path} to Recycle Bin?`)) return;
        try {
            const response = await fetch(`/api/files?path=${encodeURIComponent(path)}&permanent=${isTrash}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${authToken}` } });
            if (response.status === 401) { location.reload(); return; }
            if (response.ok) fetchFiles();
            else { const data = await response.json(); alert(data.error || 'Failed to delete'); }
        } catch (error) { console.error('Error deleting:', error); }
    };

    function formatBytes(bytes, decimals = 2) {
        if (bytes === null || bytes === undefined) return '';
        if (!+bytes) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
    }
});
