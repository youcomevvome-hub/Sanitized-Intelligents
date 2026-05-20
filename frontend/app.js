/* Sanitizer frontend - shared script for dashboard + intelligence pages. */
(() => {
    "use strict";

    const $ = (sel) => document.querySelector(sel);

    const state = {
        file: null,
        files: [],
        beforeBlob: null,
        beforeUrl: null,
        afterUrl: null,
        afterBlob: null,
        afterName: null,
        category: null,
        maskMode: "blur",
        showingBefore: false,
        searchFiles: [],
        selectedNames: new Set(),
        groupName: "bulk",
        bulkMaskMode: "blur",
        mosaicUrls: [],
        blurScope: "exact",  // "exact" = single char, "word" = all chars matching that char in words
        videoFaces: [],
        videoFaceMode: "blur-selected",
        selectedVideoFaceIds: new Set(),
        videoRedactionRegion: "face_only",
    };

    const IMAGE_EXT = ["jpg", "jpeg", "png", "tif", "tiff", "bmp", "webp"];
    const VIDEO_EXT = ["mp4", "avi", "mov", "mkv", "webm"];
    const TEXT_EXT = ["txt", "csv", "md", "json"];

    function fileKey(file) {
        return `${file.name}::${file.size}::${file.lastModified || 0}`;
    }

    function categorize(filename) {
        const ext = (filename.split(".").pop() || "").toLowerCase();
        if (IMAGE_EXT.includes(ext)) return "image";
        if (VIDEO_EXT.includes(ext)) return "video";
        if (TEXT_EXT.includes(ext)) return "text";
        if (ext === "pdf") return "pdf";
        if (ext === "docx") return "docx";
        return "unknown";
    }

    function xhrFormRequest(url, formData, { responseType = "blob", onProgress } = {}) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("POST", url, true);

            if (responseType === "blob") {
                xhr.responseType = "blob";
            }

            xhr.upload.onprogress = (evt) => {
                if (!onProgress || !evt.lengthComputable) return;
                const pct = Math.max(0, Math.min(100, Math.round((evt.loaded / evt.total) * 100)));
                onProgress(pct);
            };

            xhr.onerror = () => reject(new Error("Network error during upload."));
            xhr.onabort = () => reject(new Error("Upload was cancelled."));

            xhr.onload = () => {
                const status = xhr.status || 0;
                const ok = status >= 200 && status < 300;
                const getHeader = (name) => xhr.getResponseHeader(name);

                if (responseType === "json") {
                    let parsed = null;
                    try {
                        parsed = JSON.parse(xhr.responseText || "null");
                    } catch {
                        parsed = null;
                    }
                    if (!ok) {
                        const msg = (parsed && (parsed.detail || parsed.message)) || xhr.responseText || `HTTP ${status}`;
                        reject(new Error(String(msg).slice(0, 220)));
                        return;
                    }
                    resolve({ status, ok, data: parsed, getHeader });
                    return;
                }

                if (!ok) {
                    reject(new Error(`API error ${status}`));
                    return;
                }

                resolve({ status, ok, data: xhr.response, getHeader });
            };

            xhr.send(formData);
        });
    }

    async function checkHealth() {
        const pill = $("#health-pill");
        const txt = $("#health-text");
        if (!pill || !txt) return;
        try {
            const r = await fetch("/health");
            if (!r.ok) throw new Error("bad status");
            await r.json();
            pill.classList.add("is-ok");
            txt.textContent = "API ready";
        } catch {
            pill.classList.add("is-err");
            txt.textContent = "API offline";
        }
    }

    function initThemeToggle() {
        const root = document.documentElement;
        const stored = localStorage.getItem("sanitize-theme");
        const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
        const theme = stored || (prefersDark ? "dark" : "light");
        root.setAttribute("data-theme", theme);

        const navInner = $(".nav__inner");
        if (!navInner) return;

        let btn = document.querySelector(".theme-toggle");
        if (!btn) {
            btn = document.createElement("button");
            btn.type = "button";
            btn.className = "theme-toggle";
            navInner.appendChild(btn);
        }

        const refreshLabel = () => {
            const mode = root.getAttribute("data-theme") || "light";
            // Flat 1D B/W line icons. currentColor follows --ink-900 so they
            // automatically invert with theme.
            const sun = '<svg class="theme-toggle__icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
            const moon = '<svg class="theme-toggle__icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z"/></svg>';
            btn.innerHTML = mode === "dark"
                ? `${sun}<span>Light</span>`
                : `${moon}<span>Dark</span>`;
            btn.setAttribute("aria-label", mode === "dark" ? "Switch to light mode" : "Switch to dark mode");
        };

        btn.addEventListener("click", () => {
            const current = root.getAttribute("data-theme") || "light";
            const next = current === "dark" ? "light" : "dark";
            root.setAttribute("data-theme", next);
            localStorage.setItem("sanitize-theme", next);
            refreshLabel();
        });

        refreshLabel();
    }

    function initMobileNav() {
        const navLinks = $(".nav__links");
        if (!navLinks) return;
        let burger = document.querySelector(".nav__burger");
        if (!burger) {
            burger = document.createElement("button");
            burger.type = "button";
            burger.className = "nav__burger";
            burger.innerHTML = "<span></span><span></span><span></span>";
            const navInner = $(".nav__inner");
            if (navInner) navInner.appendChild(burger);
        }
        burger.addEventListener("click", () => {
            burger.classList.toggle("is-active");
            navLinks.classList.toggle("is-open");
        });
        navLinks.querySelectorAll("a").forEach(a => {
            a.addEventListener("click", () => {
                burger.classList.remove("is-active");
                navLinks.classList.remove("is-open");
            });
        });
    }

    function initDashboardPage() {
        const dz = $("#dropzone");
        const fi = $("#file-input");
        const runBtn = $("#run");
        if (!dz || !fi || !runBtn) return;

        function setStatus(msg, { busy = false, error = false } = {}) {
            const el = $("#status");
            if (!el) return;
            el.hidden = false;
            el.textContent = msg;
            el.classList.toggle("is-busy", busy);
            el.classList.toggle("is-error", error);
        }

        function clearStatus() {
            const el = $("#status");
            if (el) el.hidden = true;
        }

        function setVideoFaceStatus(msg, { busy = false, error = false } = {}) {
            const el = $("#video-face-status");
            if (!el) return;
            if (!msg) {
                el.hidden = true;
                return;
            }
            el.hidden = false;
            el.textContent = msg;
            el.classList.toggle("is-busy", busy);
            el.classList.toggle("is-error", error);
        }

        function renderVideoFaceGrid() {
            const panel = $("#video-face-panel");
            const grid = $("#video-face-grid");
            if (!panel || !grid) return;

            if (state.category !== "video") {
                panel.hidden = true;
                grid.innerHTML = "";
                return;
            }
            panel.hidden = false;

            if (!state.videoFaces.length) {
                grid.innerHTML = '<div class="empty-state">No faces detected in first frame.</div>';
                return;
            }

            grid.innerHTML = state.videoFaces.map((f) => {
                const checked = state.selectedVideoFaceIds.has(f.id) ? "checked" : "";
                return `
                <label class="folder-card" style="cursor:pointer;">
                    <div style="display:flex; align-items:center; gap:10px;">
                        <input type="checkbox" data-face-id="${f.id}" ${checked} />
                        <strong>${f.id}</strong>
                    </div>
                    <div style="margin-top:10px; border-radius:10px; overflow:hidden; background:#111; min-height:80px; display:flex; align-items:center; justify-content:center;">
                        ${f.thumbnail ? `<img src="data:image/jpeg;base64,${f.thumbnail}" alt="${f.id}" style="width:100%; height:auto; object-fit:cover;" />` : `<span style="color:#fff; font-size:12px;">No preview</span>`}
                    </div>
                </label>`;
            }).join("");

            grid.querySelectorAll("input[data-face-id]").forEach((cb) => {
                cb.addEventListener("change", (e) => {
                    const id = e.target.getAttribute("data-face-id");
                    if (e.target.checked) state.selectedVideoFaceIds.add(id);
                    else state.selectedVideoFaceIds.delete(id);
                });
            });
        }

        async function detectVideoFaces(file) {
            state.videoFaces = [];
            state.selectedVideoFaceIds = new Set();
            renderVideoFaceGrid();
            setVideoFaceStatus("Detecting faces in early frames...", { busy: true });

            try {
                const form = new FormData();
                form.append("file", file);
                const r = await fetch("/sanitize/video/faces", { method: "POST", body: form });
                if (!r.ok) throw new Error(`Face preview failed (${r.status})`);
                const payload = await r.json();
                state.videoFaces = payload.faces || [];
                state.selectedVideoFaceIds = new Set(state.videoFaces.map((f) => f.id));
                renderVideoFaceGrid();
                setVideoFaceStatus(state.videoFaces.length ? `Detected ${state.videoFaces.length} face(s).` : "No faces detected.");
            } catch (e) {
                setVideoFaceStatus(e.message || "Face preview failed.", { error: true });
            }
        }

        function setPrimaryFile(file) {
            if (!file) {
                state.file = null;
                state.category = null;
                if (state.beforeUrl) URL.revokeObjectURL(state.beforeUrl);
                state.beforeUrl = null;
                state.beforeBlob = null;
                return;
            }
            state.file = file;
            state.category = categorize(file.name);
            state.beforeBlob = file.slice(0, file.size, file.type || "application/octet-stream");

            if (state.beforeUrl) URL.revokeObjectURL(state.beforeUrl);
            state.beforeUrl = URL.createObjectURL(state.beforeBlob);

            if (state.category === "video") {
                detectVideoFaces(file);
            } else {
                state.videoFaces = [];
                state.selectedVideoFaceIds = new Set();
                renderVideoFaceGrid();
                setVideoFaceStatus("");
            }
            runBtn.disabled = false;
            clearStatus();
        }

        function updateUploadMeta() {
            const meta = $("#file-meta");
            const name = $("#file-name");
            const files = state.files;
            if (!meta || !name) return;
            meta.hidden = !files.length;
            if (!files.length) return;

            if (files.length === 1) {
                const file = files[0];
                name.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
            } else {
                const totalMb = files.reduce((sum, f) => sum + f.size, 0) / 1024 / 1024;
                const previewName = state.file ? state.file.name : files[0].name;
                name.textContent = `${files.length} uploads · ${totalMb.toFixed(2)} MB total · previewing ${previewName}`;
            }
        }

        function renderUploadList() {
            const list = $("#upload-list");
            if (!list) return;
            if (!state.files.length) {
                list.hidden = true;
                list.innerHTML = "";
                return;
            }

            list.hidden = false;
            list.innerHTML = state.files.map((f, idx) => {
                const active = state.file && fileKey(state.file) === fileKey(f) ? "is-active" : "";
                return `
                    <button type="button" class="upload-chip ${active}" data-upload-index="${idx}" title="Preview this upload">
                        <span class="upload-chip__name">${f.name}</span>
                        <span class="upload-chip__size">${(f.size / 1024 / 1024).toFixed(2)} MB</span>
                        <span class="upload-chip__close" data-upload-remove="${idx}" aria-label="Remove ${f.name}">×</span>
                    </button>`;
            }).join("");

            list.querySelectorAll("[data-upload-index]").forEach((btn) => {
                btn.addEventListener("click", (e) => {
                    const removeAttr = e.target && e.target.getAttribute ? e.target.getAttribute("data-upload-remove") : null;
                    if (removeAttr !== null) return;
                    const idx = Number(btn.getAttribute("data-upload-index"));
                    if (Number.isNaN(idx) || !state.files[idx]) return;
                    setPrimaryFile(state.files[idx]);
                    updateUploadMeta();
                    renderUploadList();
                });
            });

            list.querySelectorAll("[data-upload-remove]").forEach((btn) => {
                btn.addEventListener("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const idx = Number(btn.getAttribute("data-upload-remove"));
                    if (Number.isNaN(idx)) return;
                    removeUploadAt(idx);
                });
            });
        }

        function addFiles(filesLike) {
            const incoming = Array.from(filesLike || []);
            if (!incoming.length) return;

            const existing = new Set(state.files.map((f) => fileKey(f)));
            const uniqueIncoming = incoming.filter((f) => !existing.has(fileKey(f)));
            if (!uniqueIncoming.length) return;

            state.files = [...state.files, ...uniqueIncoming];
            if (!state.file) {
                setPrimaryFile(state.files[0]);
            }
            updateUploadMeta();
            renderUploadList();
            runBtn.disabled = false;
            clearStatus();
        }

        function removeUploadAt(idx) {
            if (idx < 0 || idx >= state.files.length) return;
            const removingActive = state.file && fileKey(state.file) === fileKey(state.files[idx]);
            state.files.splice(idx, 1);

            if (!state.files.length) {
                clearFile();
                return;
            }

            if (removingActive) {
                setPrimaryFile(state.files[Math.min(idx, state.files.length - 1)]);
            }
            updateUploadMeta();
            renderUploadList();
        }

        function clearFile() {
            state.file = null;
            state.files = [];
            state.beforeBlob = null;
            state.category = null;
            if (state.beforeUrl) URL.revokeObjectURL(state.beforeUrl);
            state.beforeUrl = null;
            fi.value = "";
            const meta = $("#file-meta");
            if (meta) meta.hidden = true;
            const list = $("#upload-list");
            if (list) {
                list.hidden = true;
                list.innerHTML = "";
            }
            state.videoFaces = [];
            state.selectedVideoFaceIds = new Set();
            renderVideoFaceGrid();
            setVideoFaceStatus("");
            runBtn.disabled = true;
        }

        function buildOptions() {
            const kernel = $("#kernel");
            const keywordsEl = $("#keywords");
            const patternsEl = $("#patterns");
            const replacementTextEl = $("#replacement-text");
            const customReplacementsEl = $("#custom-replacements");
            let whitelistIds = [];
            let blacklistIds = [];
            if (state.category === "video" && state.videoFaces.length) {
                const selected = Array.from(state.selectedVideoFaceIds);
                if (state.videoFaceMode === "keep-selected") whitelistIds = selected;
                else blacklistIds = selected;
            }

            const replacementPairs = {};
            const rawPairs = (customReplacementsEl && customReplacementsEl.value ? customReplacementsEl.value : "")
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
            rawPairs.forEach((pair) => {
                const idx = pair.indexOf(":");
                if (idx <= 0) return;
                const from = pair.slice(0, idx).trim();
                const to = pair.slice(idx + 1).trim();
                if (!from) return;
                replacementPairs[from] = to;
            });

            return {
                mask_mode: state.maskMode,
                blur_kernel: kernel ? parseInt(kernel.value, 10) : 51,
                redact_faces: !!($("#opt-faces") && $("#opt-faces").checked),
                redact_numbers: !!($("#opt-numbers") && $("#opt-numbers").checked),
                redact_pii: !!($("#opt-pii") && $("#opt-pii").checked),
                keywords: keywordsEl ? keywordsEl.value.split(",").map((s) => s.trim()).filter(Boolean) : [],
                custom_patterns: patternsEl ? patternsEl.value.split(",").map((s) => s.trim()).filter(Boolean) : [],
                replacement_text: replacementTextEl ? replacementTextEl.value.trim() : "",
                custom_replacements: replacementPairs,
                blur_scope: state.blurScope || "exact",
                whitelist_face_ids: whitelistIds,
                blacklist_face_ids: blacklistIds,
                video_redaction_region: state.videoRedactionRegion || "face_only",
            };
        }

        function renderImageCompare() {
            const img = $("#compare-display");
            const label = $("#compare-label");
            const viewer = $("#viewer-compare");
            if (!img || !label || !viewer) return;
            state.showingBefore = false;
            img.src = state.afterUrl;
            label.textContent = "After";
            viewer.hidden = false;
        }

        function setComparisonView(showBefore) {
            if (state.category !== "image") return;
            const img = $("#compare-display");
            const label = $("#compare-label");
            const toggle = $("#compare-toggle");
            if (!img || !label || !toggle) return;
            state.showingBefore = showBefore;
            img.src = showBefore ? state.beforeUrl : state.afterUrl;
            label.textContent = showBefore ? "Before" : "After";
            toggle.classList.toggle("is-active", showBefore);
        }

        function attachViewerToggle() {
            const toggle = $("#compare-toggle");
            const viewer = $("#viewer-compare");
            if (!toggle || !viewer) return;

            const start = (e) => {
                e.preventDefault();
                setComparisonView(true);
            };
            const end = (e) => {
                e.preventDefault();
                setComparisonView(false);
            };

            toggle.addEventListener("pointerdown", start);
            toggle.addEventListener("pointerup", end);
            toggle.addEventListener("pointerleave", end);
            toggle.addEventListener("pointercancel", end);

            viewer.addEventListener("pointerdown", (e) => {
                if (e.target === toggle) return;
                setComparisonView(true);
            });
            viewer.addEventListener("pointerup", () => setComparisonView(false));
            viewer.addEventListener("pointerleave", () => setComparisonView(false));
            viewer.addEventListener("pointercancel", () => setComparisonView(false));
        }

        function renderVideoSideBySide() {
            const inner = $("#viewer-generic-inner");
            const generic = $("#viewer-generic");
            if (!inner || !generic) return;
            inner.innerHTML = `
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
                    <div>
                        <div style="font-size:12px; color:var(--ink-500); margin-bottom:8px; text-transform:uppercase; letter-spacing:.06em;">Before</div>
                        <video controls src="${state.beforeUrl}" style="width:100%; border-radius:12px; background:#000;"></video>
                    </div>
                    <div>
                        <div style="font-size:12px; color:var(--ink-500); margin-bottom:8px; text-transform:uppercase; letter-spacing:.06em;">After</div>
                        <video controls src="${state.afterUrl}" style="width:100%; border-radius:12px; background:#000;"></video>
                    </div>
                </div>`;
            generic.hidden = false;
        }

        function renderPdfInline() {
            const inner = $("#viewer-generic-inner");
            const generic = $("#viewer-generic");
            if (!inner || !generic) return;
            inner.innerHTML = `
                <div class="doc-compare-grid">
                    <div class="doc-pane">
                        <div class="doc-pane__label">Before</div>
                        <iframe src="${state.beforeUrl}" title="Original PDF"></iframe>
                        <a class="doc-pane__link" href="${state.beforeUrl}" target="_blank" rel="noopener">Open original PDF in new tab</a>
                    </div>
                    <div class="doc-pane">
                        <div class="doc-pane__label">After</div>
                        <iframe src="${state.afterUrl}" title="Sanitized PDF"></iframe>
                        <a class="doc-pane__link" href="${state.afterUrl}" target="_blank" rel="noopener">Open sanitized PDF in new tab</a>
                    </div>
                </div>`;
            generic.hidden = false;
        }

        async function renderDocxSideBySide() {
            const inner = $("#viewer-generic-inner");
            const generic = $("#viewer-generic");
            if (!inner || !generic || !state.afterBlob || !state.file) return;

            const hasMammoth = !!(window.mammoth && typeof window.mammoth.convertToHtml === "function");
            const fallbackHtml = "<p>Preview unavailable for this document version. Use download/open to inspect.</p>";

            const convertDocx = async (blob) => {
                if (!hasMammoth) return fallbackHtml;
                try {
                    const buf = await blob.arrayBuffer();
                    const res = await window.mammoth.convertToHtml({ arrayBuffer: buf });
                    return res.value || fallbackHtml;
                } catch {
                    return fallbackHtml;
                }
            };

            const [beforeHtml, afterHtml] = await Promise.all([
                convertDocx(state.beforeBlob || state.file),
                convertDocx(state.afterBlob),
            ]);

            inner.innerHTML = `
                <div class="doc-editor-toolbar" id="doc-editor-toolbar">
                    <span class="doc-editor-toolbar__title">Edit sanitized document view</span>
                    <select id="doc-font-family" class="doc-editor-select">
                        <option value="Roboto, sans-serif">Roboto</option>
                        <option value="Arial, sans-serif">Arial</option>
                        <option value="Georgia, serif">Georgia</option>
                        <option value="'Times New Roman', serif">Times New Roman</option>
                        <option value="'Courier New', monospace">Courier New</option>
                    </select>
                    <select id="doc-font-size" class="doc-editor-select">
                        <option value="12">12</option>
                        <option value="14" selected>14</option>
                        <option value="16">16</option>
                        <option value="18">18</option>
                        <option value="20">20</option>
                    </select>
                    <button type="button" class="doc-editor-btn" data-cmd="bold"><strong>B</strong></button>
                    <button type="button" class="doc-editor-btn" data-cmd="italic"><em>I</em></button>
                    <button type="button" class="doc-editor-btn" data-cmd="underline"><u>U</u></button>
                </div>
                <div class="doc-compare-grid">
                    <div class="doc-pane">
                        <div class="doc-pane__label">Before</div>
                        <div class="doc-pane__content">${beforeHtml}</div>
                        <a class="doc-pane__link" href="${state.beforeUrl}" download="${state.file.name}">Download original DOCX</a>
                    </div>
                    <div class="doc-pane">
                        <div class="doc-pane__label">After</div>
                        <div class="doc-pane__content" id="doc-after-editor" contenteditable="true">${afterHtml}</div>
                        <a class="doc-pane__link" href="${state.afterUrl}" download="${state.afterName || "sanitized.docx"}">Download sanitized DOCX</a>
                    </div>
                </div>`;

            const editor = $("#doc-after-editor");
            const fontFamily = $("#doc-font-family");
            const fontSize = $("#doc-font-size");

            if (editor && fontFamily && fontSize) {
                editor.style.fontFamily = fontFamily.value;
                editor.style.fontSize = `${fontSize.value}px`;

                const focusEditor = () => editor.focus();
                const commandButtons = inner.querySelectorAll(".doc-editor-btn[data-cmd]");
                commandButtons.forEach((btn) => {
                    btn.addEventListener("click", () => {
                        focusEditor();
                        document.execCommand(btn.getAttribute("data-cmd"));
                    });
                });

                fontFamily.addEventListener("change", () => {
                    editor.style.fontFamily = fontFamily.value;
                    focusEditor();
                });

                fontSize.addEventListener("change", () => {
                    editor.style.fontSize = `${fontSize.value}px`;
                    focusEditor();
                });
            }

            generic.hidden = false;
        }

        async function renderTextSideBySide() {
            const inner = $("#viewer-generic-inner");
            const generic = $("#viewer-generic");
            if (!inner || !generic || !state.afterBlob || !state.file || !state.beforeBlob) return;
            const [beforeText, afterText] = await Promise.all([state.beforeBlob.text(), state.afterBlob.text()]);
            inner.innerHTML = `
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
                    <div>
                        <div style="font-size:12px; color:var(--ink-500); margin-bottom:8px; text-transform:uppercase; letter-spacing:.06em;">Before</div>
                        <pre id="pre-before"></pre>
                    </div>
                    <div>
                        <div style="font-size:12px; color:var(--ink-500); margin-bottom:8px; text-transform:uppercase; letter-spacing:.06em;">After</div>
                        <pre id="pre-after"></pre>
                    </div>
                </div>`;
            const preBefore = $("#pre-before");
            const preAfter = $("#pre-after");
            if (preBefore) preBefore.textContent = beforeText;
            if (preAfter) preAfter.textContent = afterText;
            generic.hidden = false;
        }

        function renderDownloadOnly() {
            const inner = $("#viewer-generic-inner");
            const generic = $("#viewer-generic");
            if (!inner || !generic) return;
            inner.innerHTML = `
                <p style="margin:0; color:var(--ink-500); font-size:15px;">
                    The sanitized file is ready. Inline preview is not available for this format.
                </p>`;
            generic.hidden = false;
        }

        function renderStats(summary) {
            const block = $("#results");
            if (!block) return;
            block.hidden = false;
            const byKind = (summary && summary.by_kind) || {};
            if ($("#stat-total")) $("#stat-total").textContent = (summary && summary.total_detections) || 0;
            if ($("#stat-faces")) $("#stat-faces").textContent = byKind.face || 0;
            if ($("#stat-numbers")) $("#stat-numbers").textContent = byKind.number || 0;
            if ($("#stat-pii")) $("#stat-pii").textContent = (byKind.pii || 0) + (byKind.custom || 0);

            const dl = $("#download");
            if (dl) {
                dl.href = state.afterUrl;
                dl.download = state.afterName;
            }
        }

        async function handleResult(blob, summary) {
            if (state.afterUrl) URL.revokeObjectURL(state.afterUrl);
            state.afterBlob = blob;
            state.afterUrl = URL.createObjectURL(blob);
            state.afterName = `sanitized_${state.file.name}`;

            const empty = $("#viewer-empty");
            const compare = $("#viewer-compare");
            const generic = $("#viewer-generic");
            if (empty) empty.hidden = true;
            if (compare) compare.hidden = true;
            if (generic) generic.hidden = true;

            if (state.category === "image") {
                renderImageCompare();
            } else if (state.category === "video") {
                renderVideoSideBySide();
            } else if (state.category === "pdf") {
                renderPdfInline();
            } else if (state.category === "docx") {
                await renderDocxSideBySide();
            } else if (state.category === "text") {
                await renderTextSideBySide();
            } else {
                renderDownloadOnly();
            }

            renderStats(summary);
        }

        async function runSanitize() {
            const files = state.files && state.files.length ? state.files : (state.file ? [state.file] : []);
            if (!files.length) return;
            const hasZip = files.some((f) => (f.name || "").toLowerCase().endsWith(".zip"));

            runBtn.disabled = true;
            setStatus("Uploading... 0%", { busy: true });
            try {
                if (files.length > 1 || hasZip) {
                    const form = new FormData();
                    files.forEach((f) => form.append("files", f));
                    form.append("options", JSON.stringify(buildOptions()));
                    form.append("group_name", "dashboard-bulk");

                    const res = await xhrFormRequest("/sanitize/bulk", form, {
                        responseType: "blob",
                        onProgress: (pct) => setStatus(`Uploading... ${pct}%`, { busy: true }),
                    });

                    if (state.afterUrl) URL.revokeObjectURL(state.afterUrl);
                    state.afterBlob = res.data;
                    state.afterUrl = URL.createObjectURL(state.afterBlob);
                    state.afterName = "dashboard-bulk_sanitized.zip";

                    const empty = $("#viewer-empty");
                    const compare = $("#viewer-compare");
                    const generic = $("#viewer-generic");
                    const inner = $("#viewer-generic-inner");
                    if (empty) empty.hidden = true;
                    if (compare) compare.hidden = true;
                    if (generic) generic.hidden = false;
                    if (inner) {
                        inner.innerHTML = `<p style="margin:0; color:var(--ink-500); font-size:15px;">Bulk sanitize complete for ${files.length} upload(s)${hasZip ? " including ZIP extraction" : ""}. Download the ZIP result below.</p>`;
                    }

                    const block = $("#results");
                    if (block) block.hidden = false;
                    if ($("#stat-total")) $("#stat-total").textContent = "-";
                    if ($("#stat-faces")) $("#stat-faces").textContent = "-";
                    if ($("#stat-numbers")) $("#stat-numbers").textContent = "-";
                    if ($("#stat-pii")) $("#stat-pii").textContent = "-";
                    const dl = $("#download");
                    if (dl) {
                        dl.href = state.afterUrl;
                        dl.download = state.afterName;
                    }
                    setStatus("Done. Bulk ZIP is ready.");
                } else {
                    const endpoint = state.category === "video" ? "/sanitize/video" : "/sanitize";
                    const form = new FormData();
                    form.append("file", state.file);
                    form.append("options", JSON.stringify(buildOptions()));

                    const res = await xhrFormRequest(endpoint, form, {
                        responseType: "blob",
                        onProgress: (pct) => setStatus(`Uploading... ${pct}%`, { busy: true }),
                    });
                    setStatus("Processing uploaded file...", { busy: true });
                    const summaryHeader = res.getHeader("X-Sanitizer-Summary");
                    const summary = summaryHeader ? JSON.parse(summaryHeader) : null;
                    const blob = res.data;
                    await handleResult(blob, summary);
                    setStatus("Done. Compare the result below.");
                }
            } catch (e) {
                setStatus(e.message || "Sanitize failed.", { error: true });
            } finally {
                runBtn.disabled = false;
            }
        }

        // Keep native <label> click behavior for broad mobile compatibility.
        fi.addEventListener("click", () => {
            fi.value = "";
        });
        fi.addEventListener("change", (e) => {
            const files = e.target && e.target.files ? e.target.files : null;
            if (files && files.length) addFiles(files);
        });
        ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("is-drag"); }));
        ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("is-drag"); }));
        dz.addEventListener("drop", (e) => {
            if (e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
        });

        const rm = $("#file-remove");
        if (rm) rm.addEventListener("click", (e) => { e.preventDefault(); clearFile(); });

        document.querySelectorAll(".seg__btn").forEach((b) => {
            if (b.classList.contains("bulk-mask")) return;
            b.addEventListener("click", () => {
                if (b.dataset.mask !== undefined) {
                    document.querySelectorAll(".seg__btn[data-mask]").forEach((x) => x.classList.remove("is-active"));
                    b.classList.add("is-active");
                    state.maskMode = b.dataset.mask;
                } else if (b.dataset.scope !== undefined) {
                    document.querySelectorAll(".seg__btn[data-scope]").forEach((x) => x.classList.remove("is-active"));
                    b.classList.add("is-active");
                    state.blurScope = b.dataset.scope;
                } else if (b.dataset.vmode !== undefined) {
                    document.querySelectorAll(".seg__btn[data-vmode]").forEach((x) => x.classList.remove("is-active"));
                    b.classList.add("is-active");
                    state.videoFaceMode = b.dataset.vmode;
                } else if (b.dataset.vregion !== undefined) {
                    document.querySelectorAll(".seg__btn[data-vregion]").forEach((x) => x.classList.remove("is-active"));
                    b.classList.add("is-active");
                    state.videoRedactionRegion = b.dataset.vregion;
                }
            });
        });

        const kernel = $("#kernel");
        if (kernel && $("#kernel-value")) {
            kernel.addEventListener("input", () => { $("#kernel-value").textContent = kernel.value; });
        }

        runBtn.addEventListener("click", runSanitize);
        attachViewerToggle();
    }

    function initIntelligencePage() {
        const dz = $("#search-dropzone");
        const fi = $("#search-files");
        if (!dz || !fi) return;

        function setStatus(sel, msg, { busy = false, error = false } = {}) {
            const el = $(sel);
            if (!el) return;
            el.hidden = false;
            el.textContent = msg;
            el.classList.toggle("is-busy", busy);
            el.classList.toggle("is-error", error);
        }

        function fileKey(f) {
            return `${f.name}::${f.size}`;
        }

        function inferType(filename) {
            return (filename.split(".").pop() || "").toLowerCase();
        }

        function selectedFilesByScope() {
            const all = state.searchFiles;
            if (!all.length) return [];
            const scope = ($("#bulk-scope") && $("#bulk-scope").value) || "selected";
            if (scope === "all") return all;

            const selected = all.filter((f) => state.selectedNames.has(fileKey(f)));
            if (scope === "selected") return selected;
            if (!selected.length) return [];

            const ext = inferType(selected[0].name);
            return all.filter((f) => inferType(f.name) === ext);
        }

        function renderGroupFiles() {
            const card = $("#grouped-files-card");
            const root = $("#grouped-files");
            const summary = $("#grouped-files-summary");
            if (!card || !root || !summary) return;
            if (!state.searchFiles.length) {
                card.hidden = true;
                return;
            }

            card.hidden = false;
            summary.textContent = `Folder: ${state.groupName} · ${state.searchFiles.length} files`;
            root.innerHTML = state.searchFiles.map((f) => {
                const key = fileKey(f);
                const checked = state.selectedNames.has(key) ? "checked" : "";
                return `
                    <label class="group-file-item">
                        <input type="checkbox" data-file-key="${key}" ${checked} />
                        <span class="group-file-name">${f.name}</span>
                        <span class="group-file-size">${(f.size / 1024 / 1024).toFixed(2)} MB</span>
                    </label>`;
            }).join("");

            root.querySelectorAll("input[type='checkbox']").forEach((cb) => {
                cb.addEventListener("change", (e) => {
                    const key = e.target.getAttribute("data-file-key");
                    if (e.target.checked) state.selectedNames.add(key);
                    else state.selectedNames.delete(key);
                });
            });
        }

        function clearMosaicUrls() {
            state.mosaicUrls.forEach((u) => URL.revokeObjectURL(u));
            state.mosaicUrls = [];
        }

        function renderMosaic() {
            const card = $("#mosaic-card");
            const grid = $("#mosaic-grid");
            if (!card || !grid) return;
            clearMosaicUrls();

            if (!state.searchFiles.length) {
                card.hidden = true;
                grid.innerHTML = "";
                return;
            }

            card.hidden = false;
            const chunks = state.searchFiles.map((f, idx) => {
                const kind = categorize(f.name);
                if (kind === "image") {
                    const url = URL.createObjectURL(f);
                    state.mosaicUrls.push(url);
                    return `<article class="mosaic-tile mosaic-tile--img ${idx % 5 === 0 ? "mosaic-tile--tall" : ""}"><img src="${url}" alt="${f.name}" /><span>${f.name}</span></article>`;
                }
                const glyph = kind === "pdf" ? "PDF" : kind === "docx" ? "DOC" : kind === "text" ? "TXT" : "FILE";
                return `<article class="mosaic-tile mosaic-tile--doc ${idx % 4 === 0 ? "mosaic-tile--wide" : ""}"><div class="mosaic-doc-glyph">${glyph}</div><span>${f.name}</span></article>`;
            });
            grid.innerHTML = chunks.join("");
        }

        function showSearchFiles(files) {
            state.searchFiles = Array.from(files || []);
            state.selectedNames = new Set(state.searchFiles.map((f) => fileKey(f)));
            const meta = $("#search-meta");
            const metaName = $("#search-meta-name");
            if (meta && metaName) {
                meta.hidden = !state.searchFiles.length;
                if (state.searchFiles.length) {
                    metaName.textContent = `${state.searchFiles.length} files selected`;
                }
            }
            renderGroupFiles();
            renderMosaic();
        }

        function renderSearchResults(payload) {
            const card = $("#search-results-card");
            const summary = $("#search-results-summary");
            const root = $("#search-results");
            if (!card || !summary || !root) return;

            card.hidden = false;
            summary.textContent = `${payload.total_matches || 0} matches in folder ${state.groupName}.`;
            if (!payload.matches || !payload.matches.length) {
                root.innerHTML = `<div class="search-item"><strong>No matches found.</strong><p>Try another query or mode.</p></div>`;
                return;
            }
            root.innerHTML = payload.matches.map((m) => `
                <article class="search-item">
                    <div class="search-item__meta">
                        <span class="search-pill">${m.category}</span>
                        <span class="search-score">score ${m.score}</span>
                    </div>
                    <h4>${m.filename}</h4>
                    <p>${m.preview || "Match found"}</p>
                </article>`).join("");
        }

        async function runSearch() {
            if (!state.searchFiles.length) {
                setStatus("#search-status", "Select files first.", { error: true });
                return;
            }
            const mode = ($("#search-mode") && $("#search-mode").value) || "text";
            const query = ($("#search-query") && $("#search-query").value.trim()) || "";
            if (mode !== "signature" && !query) {
                setStatus("#search-status", "Enter a query for this mode.", { error: true });
                return;
            }

            const form = new FormData();
            selectedFilesByScope().forEach((f) => form.append("files", f));
            form.append("query", query || "signature");
            form.append("mode", mode);
            const queryImg = $("#search-query-image");
            if (queryImg && queryImg.files && queryImg.files[0]) {
                form.append("query_image", queryImg.files[0]);
            }

            const runBtn = $("#search-run");
            if (runBtn) runBtn.disabled = true;
            setStatus("#search-status", "Searching folder...", { busy: true });
            try {
                const res = await fetch("/sanitize/search", { method: "POST", body: form });
                if (!res.ok) throw new Error(`Search failed (${res.status})`);
                const payload = await res.json();
                renderSearchResults(payload);
                setStatus("#search-status", "Search complete.");
            } catch (e) {
                setStatus("#search-status", e.message || "Search failed.", { error: true });
            } finally {
                if (runBtn) runBtn.disabled = false;
            }
        }

        function buildBulkOptions() {
            return {
                mask_mode: state.bulkMaskMode,
                blur_kernel: 51,
                redact_faces: !!($("#bulk-faces") && $("#bulk-faces").checked),
                redact_numbers: !!($("#bulk-numbers") && $("#bulk-numbers").checked),
                redact_pii: !!($("#bulk-pii") && $("#bulk-pii").checked),
                keywords: [],
                custom_patterns: [],
            };
        }

        async function runBulkTransform() {
            const files = selectedFilesByScope();
            if (!files.length) {
                setStatus("#bulk-status", "No files selected for this scope.", { error: true });
                return;
            }

            const form = new FormData();
            files.forEach((f) => form.append("files", f));
            form.append("options", JSON.stringify(buildBulkOptions()));
            form.append("group_name", state.groupName || "bulk");

            const btn = $("#bulk-run");
            if (btn) btn.disabled = true;
            setStatus("#bulk-status", "Running bulk transform...", { busy: true });
            try {
                const res = await fetch("/sanitize/bulk", { method: "POST", body: form });
                if (!res.ok) throw new Error(`Bulk transform failed (${res.status})`);
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const dl = $("#bulk-download");
                if (dl) {
                    dl.hidden = false;
                    dl.href = url;
                    dl.download = `${state.groupName || "bulk"}_sanitized.zip`;
                }
                setStatus("#bulk-status", `Bulk transform complete for ${files.length} files.`);
            } catch (e) {
                setStatus("#bulk-status", e.message || "Bulk transform failed.", { error: true });
            } finally {
                if (btn) btn.disabled = false;
            }
        }

        dz.addEventListener("click", () => fi.click());
        fi.addEventListener("change", (e) => showSearchFiles(e.target.files));
        ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("is-drag"); }));
        ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("is-drag"); }));
        dz.addEventListener("drop", (e) => {
            const files = e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files : [];
            showSearchFiles(files);
        });

        // Paste files/images from clipboard directly into intelligence workspace.
        document.addEventListener("paste", (e) => {
            const items = (e.clipboardData && e.clipboardData.items) || [];
            const pastedFiles = [];
            for (const item of items) {
                if (item.kind === "file") {
                    const f = item.getAsFile();
                    if (f) pastedFiles.push(f);
                }
            }
            if (!pastedFiles.length) return;
            const merged = [...state.searchFiles, ...pastedFiles];
            showSearchFiles(merged);
            setStatus("#group-status", `${pastedFiles.length} file(s) pasted into folder ${state.groupName}.`);
        });

        const createGroup = $("#create-group");
        if (createGroup) {
            createGroup.addEventListener("click", () => {
                const input = $("#group-name");
                state.groupName = (input && input.value.trim()) || "bulk";
                renderGroupFiles();
                setStatus("#group-status", `Folder group set to ${state.groupName}.`);
            });
        }

        document.querySelectorAll(".bulk-mask").forEach((b) => {
            b.addEventListener("click", () => {
                const group = b.getAttribute("data-mask") !== null ? "mask" : "scope";
                if (group === "mask") {
                    document.querySelectorAll(".seg__btn[data-mask]").forEach((x) => x.classList.remove("is-active"));
                    b.classList.add("is-active");
                    state.maskMode = b.dataset.mask;
                } else {
                    document.querySelectorAll(".seg__btn[data-scope]").forEach((x) => x.classList.remove("is-active"));
                    b.classList.add("is-active");
                    state.blurScope = b.dataset.scope;
                }
            });
        });

        const searchRun = $("#search-run");
        if (searchRun) searchRun.addEventListener("click", runSearch);
        const bulkRun = $("#bulk-run");
        if (bulkRun) bulkRun.addEventListener("click", runBulkTransform);
    }

    function initLibraryPage() {
        const dz = $("#lib-dropzone");          
        const grid = $("#folders-grid");
        // Page-safe: only run on the intelligence page that has these elements.
        if (!dz && !grid) return;

        const libState = {
            files: [],
            zipFiles: [],
            currentFolder: "",
            selectedStored: new Set(),
            searchMatches: [],
            selectedSearchKeys: new Set(),
            selectedFolders: new Set(),
        };

        function setStatus(sel, msg, { busy = false, error = false } = {}) {
            const el = $(sel);
            if (!el) return;
            el.hidden = false;
            el.textContent = msg;
            el.classList.toggle("is-busy", busy);
            el.classList.toggle("is-error", error);
        }

        function fmtBytes(n) {
            if (n < 1024) return `${n} B`;
            if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
            return `${(n / 1024 / 1024).toFixed(2)} MB`;
        }

        function kindBadge(kind) {
            const k = (kind || "other").toUpperCase().slice(0, 4);
            return `<span class="kind-pill kind-pill--${kind || "other"}">${k}</span>`;
        }

        function setFolderBulkStatus(msg, { busy = false, error = false } = {}) {
            const el = $("#folder-bulk-status");
            if (!el) return;
            if (!msg) {
                el.hidden = true;
                return;
            }
            el.hidden = false;
            el.textContent = msg;
            el.classList.toggle("is-busy", busy);
            el.classList.toggle("is-error", error);
        }

        function setSearchMoveStatus(msg, { busy = false, error = false } = {}) {
            const el = $("#lib-search-move-status");
            if (!el) return;
            if (!msg) {
                el.hidden = true;
                return;
            }
            el.hidden = false;
            el.textContent = msg;
            el.classList.toggle("is-busy", busy);
            el.classList.toggle("is-error", error);
        }

        function setFolderMoveStatus(msg, { busy = false, error = false } = {}) {
            const el = $("#library-folder-move-status");
            if (!el) return;
            if (!msg) {
                el.hidden = true;
                return;
            }
            el.hidden = false;
            el.textContent = msg;
            el.classList.toggle("is-busy", busy);
            el.classList.toggle("is-error", error);
        }

        function matchKey(match) {
            return `${match.folder}::${match.stored_name}`;
        }

        function setAllSearchSelections(checked) {
            if (checked) {
                libState.selectedSearchKeys = new Set(libState.searchMatches.map((m) => matchKey(m)));
            } else {
                libState.selectedSearchKeys.clear();
            }
            renderLibrarySearch({ matches: libState.searchMatches });
        }

        function setAllFolderSelections(checked) {
            const cards = grid ? Array.from(grid.querySelectorAll(".folder-card")) : [];
            if (checked) {
                cards.forEach((card) => {
                    const folder = card.dataset.folder;
                    if (!folder) return;
                    libState.selectedFolders.add(folder);
                    card.classList.add("is-selected");
                    const cb = card.querySelector('input[data-action="select-folder"]');
                    if (cb) cb.checked = true;
                });
            } else {
                libState.selectedFolders.clear();
                cards.forEach((card) => {
                    card.classList.remove("is-selected");
                    const cb = card.querySelector('input[data-action="select-folder"]');
                    if (cb) cb.checked = false;
                });
            }
        }

        async function moveSelectedFolders() {
            const selectedFolders = Array.from(libState.selectedFolders);
            if (!selectedFolders.length) {
                setFolderMoveStatus("Select one or more folders first.", { error: true });
                return;
            }

            const targetInput = $("#folder-group-target");
            const targetParent = (targetInput && targetInput.value.trim()) || "";
            const btn = $("#folder-move-selected-folders");
            if (btn) btn.disabled = true;
            setFolderMoveStatus(`Moving ${selectedFolders.length} folder(s)...`, { busy: true });

            let moved = 0;
            let skipped = 0;
            try {
                for (const sourceFolder of selectedFolders) {
                    const form = new FormData();
                    form.append("source_folder", sourceFolder);
                    form.append("target_parent", targetParent);

                    const res = await fetch("/library/folder/move", { method: "POST", body: form });
                    const payload = await res.json().catch(() => ({}));
                    if (!res.ok) {
                        skipped += 1;
                        continue;
                    }
                    if (payload && payload.moved) moved += 1;
                }

                libState.selectedFolders.clear();
                await loadFolders();
                const parentLabel = targetParent || "root";
                setFolderMoveStatus(`Moved ${moved} folder(s) into ${parentLabel}.${skipped ? ` Skipped ${skipped}.` : ""}`);
            } catch (e) {
                setFolderMoveStatus(e.message || "Failed to move selected folders.", { error: true });
            } finally {
                if (btn) btn.disabled = false;
            }
        }

        async function moveSelectedSearchMatches() {
            const targetInput = $("#lib-search-move-target");
            const targetFolder = (targetInput && targetInput.value.trim()) || "";
            const selected = libState.searchMatches.filter((m) => libState.selectedSearchKeys.has(matchKey(m)));

            if (!selected.length) {
                setSearchMoveStatus("Select one or more search results first.", { error: true });
                return;
            }
            if (!targetFolder) {
                setSearchMoveStatus("Enter a target folder name.", { error: true });
                return;
            }

            const groups = new Map();
            selected.forEach((m) => {
                if (!groups.has(m.folder)) groups.set(m.folder, []);
                groups.get(m.folder).push(m.stored_name);
            });

            const moveBtn = $("#lib-search-move-selected");
            if (moveBtn) moveBtn.disabled = true;
            setSearchMoveStatus(`Moving ${selected.length} item(s)...`, { busy: true });

            let movedCount = 0;
            let skippedCount = 0;
            try {
                for (const [sourceFolder, storedNames] of groups.entries()) {
                    if (sourceFolder === targetFolder) {
                        skippedCount += storedNames.length;
                        continue;
                    }
                    const form = new FormData();
                    form.append("source_folder", sourceFolder);
                    form.append("target_folder", targetFolder);
                    storedNames.forEach((name) => form.append("stored_names", name));

                    const r = await fetch("/library/move-bulk", { method: "POST", body: form });
                    const payload = await r.json().catch(() => ({}));
                    if (!r.ok) {
                        const detail = (payload && (payload.detail || payload.message)) || `Move failed (${r.status})`;
                        throw new Error(detail);
                    }
                    movedCount += Number(payload.moved_count || 0);
                    skippedCount += Array.isArray(payload.skipped) ? payload.skipped.length : 0;
                }

                const movedKeys = new Set(selected.map((m) => matchKey(m)));
                libState.searchMatches = libState.searchMatches.filter((m) => !movedKeys.has(matchKey(m)));
                libState.selectedSearchKeys.clear();
                renderLibrarySearch({ matches: libState.searchMatches });
                await loadFolders();
                setSearchMoveStatus(`Moved ${movedCount} item(s) to ${targetFolder}.${skippedCount ? ` Skipped ${skippedCount}.` : ""}`);
            } catch (e) {
                setSearchMoveStatus(e.message || "Failed to move selected search results.", { error: true });
            } finally {
                if (moveBtn) moveBtn.disabled = false;
            }
        }

        function refreshFolderSubtitle() {
            const sub = $("#folder-detail-sub");
            if (!sub) return;
            const base = sub.dataset.base || "";
            const selected = libState.selectedStored.size;
            sub.textContent = selected ? `${base} · ${selected} selected` : base;
        }

        function setVisibleSelection(checked) {
            const rows = document.querySelectorAll("#folder-items .library-item");
            rows.forEach((row) => {
                const stored = row.dataset.stored;
                if (!stored) return;
                const cb = row.querySelector('input[data-action="select"]');
                if (cb) cb.checked = !!checked;
                if (checked) libState.selectedStored.add(stored);
                else libState.selectedStored.delete(stored);
                row.classList.toggle("is-selected", !!checked);
            });
            refreshFolderSubtitle();
        }

        async function moveSelectedItems() {
            const source = (libState.currentFolder || "").trim();
            const targetInput = $("#folder-move-target");
            const target = (targetInput && targetInput.value.trim()) || "";
            const selected = Array.from(libState.selectedStored);

            if (!source) {
                setFolderBulkStatus("Open a folder first.", { error: true });
                return;
            }
            if (!selected.length) {
                setFolderBulkStatus("Select one or more items to move.", { error: true });
                return;
            }
            if (!target) {
                setFolderBulkStatus("Enter a target folder name.", { error: true });
                return;
            }
            if (source === target) {
                setFolderBulkStatus("Target folder must be different from source.", { error: true });
                return;
            }

            const form = new FormData();
            form.append("source_folder", source);
            form.append("target_folder", target);
            selected.forEach((name) => form.append("stored_names", name));

            const moveBtn = $("#folder-move-selected");
            if (moveBtn) moveBtn.disabled = true;
            setFolderBulkStatus(`Moving ${selected.length} item(s)...`, { busy: true });

            try {
                const r = await fetch("/library/move-bulk", { method: "POST", body: form });
                const payload = await r.json().catch(() => ({}));
                if (!r.ok) {
                    const detail = (payload && (payload.detail || payload.message)) || `Move failed (${r.status})`;
                    throw new Error(detail);
                }

                libState.selectedStored.clear();
                await loadFolders();
                await openFolder(source);
                const skipped = (payload.skipped || []).length;
                setFolderBulkStatus(
                    `Moved ${payload.moved_count || 0} item(s) to ${payload.target_folder || target}.${skipped ? ` Skipped ${skipped}.` : ""}`
                );
            } catch (e) {
                setFolderBulkStatus(e.message || "Bulk move failed.", { error: true });
            } finally {
                if (moveBtn) moveBtn.disabled = false;
            }
        }
        async function deleteSelectedItems() {
            const folder = (libState.currentFolder || "").trim();
            const selected = Array.from(libState.selectedStored);

            if (!folder) {
                setFolderBulkStatus("Open a folder first.", { error: true });
                return;
            }
            if (!selected.length) {
                setFolderBulkStatus("Select one or more items to delete.", { error: true });
                return;
            }
            if (!confirm(`Delete ${selected.length} selected item(s) from ${folder}?`)) return;

            const form = new FormData();
            form.append("folder", folder);
            selected.forEach((name) => form.append("stored_names", name));

            const btn = $("#folder-delete-selected");
            if (btn) btn.disabled = true;
            setFolderBulkStatus(`Deleting ${selected.length} item(s)...`, { busy: true });

            try {
                const r = await fetch("/library/delete-bulk", { method: "POST", body: form });
                const payload = await r.json().catch(() => ({}));
                if (!r.ok) {
                    const detail = (payload && (payload.detail || payload.message)) || `Delete failed (${r.status})`;
                    throw new Error(detail);
                }
                libState.selectedStored.clear();
                await openFolder(folder);
                await loadFolders();
                const skipped = Array.isArray(payload.skipped) ? payload.skipped.length : 0;
                setFolderBulkStatus(`Deleted ${payload.deleted_count || 0} item(s).${skipped ? ` Skipped ${skipped}.` : ""}`);
            } catch (e) {
                setFolderBulkStatus(e.message || "Bulk delete failed.", { error: true });
            } finally {
                if (btn) btn.disabled = false;
            }
        }

        function fileExt(name) {
            return ((name || "").split(".").pop() || "").toLowerCase();
        }

        async function renderLibraryPreview(folder, item) {
            const panel = $("#folder-preview");
            const title = $("#folder-preview-title");
            const body = $("#folder-preview-body");
            if (!panel || !title || !body) return;

            const fileUrl = `/library/${encodeURIComponent(folder)}/file/${encodeURIComponent(item.stored_name)}`;
            const ext = fileExt(item.stored_name || item.display_name || "");
            title.textContent = `Preview: ${item.display_name || item.stored_name}`;
            panel.hidden = false;

            if (item.kind === "image") {
                body.innerHTML = `<img src="${fileUrl}" alt="${item.display_name || item.stored_name}" style="max-width:100%; height:auto; border-radius:8px;" />`;
                return;
            }

            if (item.kind === "pdf") {
                body.innerHTML = `<iframe class="library-preview__iframe" src="${fileUrl}" title="PDF preview"></iframe>`;
                return;
            }

            if (item.kind === "text") {
                body.innerHTML = `<div class="status is-busy">Loading text preview...</div>`;
                try {
                    const r = await fetch(fileUrl);
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    const text = await r.text();
                    const escaped = (text || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
                    body.innerHTML = `<pre class="library-preview__text">${escaped}</pre>`;
                } catch {
                    body.innerHTML = `<p>Unable to preview this text file. <a href="${fileUrl}" target="_blank" rel="noopener">Open file</a></p>`;
                }
                return;
            }

            if (item.kind === "doc" && ext === "docx") {
                body.innerHTML = `<div class="status is-busy">Loading document preview...</div>`;
                if (!(window.mammoth && typeof window.mammoth.convertToHtml === "function")) {
                    body.innerHTML = `<p>DOCX preview is unavailable. <a href="${fileUrl}" target="_blank" rel="noopener">Open file</a></p>`;
                    return;
                }
                try {
                    const r = await fetch(fileUrl);
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    const blob = await r.blob();
                    const buf = await blob.arrayBuffer();
                    const out = await window.mammoth.convertToHtml({ arrayBuffer: buf });
                    body.innerHTML = `<div class="doc-pane__content">${out.value || "<p>No content.</p>"}</div>`;
                } catch {
                    body.innerHTML = `<p>Unable to preview this DOCX file. <a href="${fileUrl}" target="_blank" rel="noopener">Open file</a></p>`;
                }
                return;
            }

            body.innerHTML = `<p>Inline preview is not available for this file type. <a href="${fileUrl}" target="_blank" rel="noopener">Open file</a></p>`;
        }

        function renderFolders(payload) {
            if (!grid) return;
            const folders = payload.folders || [];
            const existing = new Set(folders.map((f) => f.folder));
            libState.selectedFolders.forEach((f) => {
                if (!existing.has(f)) libState.selectedFolders.delete(f);
            });

            if (!folders.length) {
                grid.innerHTML = `<div class="empty-state">No folders yet. Create one above or save a file.</div>`;
                return;
            }
            grid.innerHTML = folders.map((f) => `
                <article class="folder-card" data-folder="${f.folder}">
                    <header class="folder-card__head">
                        <label class="folder-card__select" title="Select folder">
                            <input type="checkbox" data-action="select-folder" data-folder="${f.folder}" ${libState.selectedFolders.has(f.folder) ? "checked" : ""} />
                        </label>
                        <div class="folder-card__icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
                            </svg>
                        </div>
                        <div>
                            <h3 class="folder-card__name">${f.name || f.folder}</h3>
                            <div class="folder-card__path">${f.folder}</div>
                        </div>
                    </header>
                    <div class="folder-card__meta">
                        <span>${f.item_count} items</span>
                        <span>${fmtBytes(f.total_size || 0)}</span>
                    </div>
                    <div class="folder-card__kinds">${(f.kinds || []).map((k) => kindBadge(k)).join("")}</div>
                    <div class="folder-card__actions">
                        <button class="btn btn--ghost btn--small" data-action="open" data-folder="${f.folder}" type="button">Open</button>
                        <button class="btn btn--ghost btn--small" data-action="group" data-folder="${f.folder}" type="button">Group</button>
                        <button class="btn btn--ghost btn--small" data-action="delete" data-folder="${f.folder}" type="button">Delete</button>
                    </div>
                </article>`).join("");

            grid.querySelectorAll(".folder-card").forEach((card) => {
                const folder = card.dataset.folder;
                if (folder && libState.selectedFolders.has(folder)) {
                    card.classList.add("is-selected");
                }
            });

            grid.querySelectorAll("button[data-action]").forEach((btn) => {
                btn.addEventListener("click", async (e) => {
                    e.stopPropagation();
                    const folder = btn.dataset.folder;
                    if (btn.dataset.action === "open") openFolder(folder);
                    else if (btn.dataset.action === "group") {
                        const parentInput = $("#folder-group-target");
                        let targetParent = (parentInput && parentInput.value.trim()) || "";
                        if (!targetParent) {
                            const prompted = prompt("Move folder into parent folder (leave empty for root):", "");
                            if (prompted === null) return;
                            targetParent = prompted.trim();
                        }
                        const form = new FormData();
                        form.append("source_folder", folder);
                        form.append("target_parent", targetParent);
                        const res = await fetch("/library/folder/move", { method: "POST", body: form });
                        if (!res.ok) {
                            const payload = await res.json().catch(() => ({}));
                            throw new Error(payload.detail || `Move folder failed (${res.status})`);
                        }
                        setFolderMoveStatus("Folder moved successfully.");
                        loadFolders();
                    }
                    else if (btn.dataset.action === "delete") {
                        if (!confirm(`Delete folder "${folder}" and all its items?`)) return;
                        await fetch(`/library/folder/${encodeURIComponent(folder)}`, { method: "DELETE" });
                        libState.selectedFolders.delete(folder);
                        loadFolders();
                    }
                });
            });
            grid.querySelectorAll('input[data-action="select-folder"]').forEach((cb) => {
                cb.addEventListener("click", (e) => e.stopPropagation());
                cb.addEventListener("change", (e) => {
                    e.stopPropagation();
                    const folder = cb.getAttribute("data-folder");
                    if (!folder) return;
                    if (cb.checked) {
                        libState.selectedFolders.add(folder);
                        cb.closest(".folder-card")?.classList.add("is-selected");
                    } else {
                        libState.selectedFolders.delete(folder);
                        cb.closest(".folder-card")?.classList.remove("is-selected");
                    }
                });
            });
            grid.querySelectorAll(".folder-card").forEach((card) => {
                card.addEventListener("click", (e) => {
                    if (e.target && e.target.closest(".folder-card__actions")) return;
                    if (e.target && e.target.closest(".folder-card__select")) return;
                    openFolder(card.dataset.folder);
                });
            });
        }

        async function loadFolders() {
            if (!grid) return;
            try {
                const r = await fetch("/library");
                if (!r.ok) throw new Error(`Load failed (${r.status})`);
                const payload = await r.json();
                renderFolders(payload);
            } catch (e) {
                grid.innerHTML = `<div class="empty-state empty-state--error">Could not load library: ${e.message}</div>`;
            }
        }
        async function deleteSelectedSearchMatches() {
            const selected = libState.searchMatches.filter((m) => libState.selectedSearchKeys.has(matchKey(m)));
            if (!selected.length) {
                setSearchMoveStatus("Select one or more search results first.", { error: true });
                return;
            }
            if (!confirm(`Delete ${selected.length} selected search result item(s)?`)) return;

            const groups = new Map();
            selected.forEach((m) => {
                if (!groups.has(m.folder)) groups.set(m.folder, []);
                groups.get(m.folder).push(m.stored_name);
            });

            const btn = $("#lib-search-delete-selected");
            if (btn) btn.disabled = true;
            setSearchMoveStatus(`Deleting ${selected.length} item(s)...`, { busy: true });

            let deletedCount = 0;
            let skippedCount = 0;
            try {
                for (const [folder, storedNames] of groups.entries()) {
                    const form = new FormData();
                    form.append("folder", folder);
                    storedNames.forEach((name) => form.append("stored_names", name));

                    const r = await fetch("/library/delete-bulk", { method: "POST", body: form });
                    const payload = await r.json().catch(() => ({}));
                    if (!r.ok) {
                        const detail = (payload && (payload.detail || payload.message)) || `Delete failed (${r.status})`;
                        throw new Error(detail);
                    }
                    deletedCount += Number(payload.deleted_count || 0);
                    skippedCount += Array.isArray(payload.skipped) ? payload.skipped.length : 0;
                }

                const deletedKeys = new Set(selected.map((m) => matchKey(m)));
                libState.searchMatches = libState.searchMatches.filter((m) => !deletedKeys.has(matchKey(m)));
                libState.selectedSearchKeys.clear();
                renderLibrarySearch({ matches: libState.searchMatches });
                await loadFolders();
                setSearchMoveStatus(`Deleted ${deletedCount} item(s).${skippedCount ? ` Skipped ${skippedCount}.` : ""}`);
            } catch (e) {
                setSearchMoveStatus(e.message || "Failed to delete selected search results.", { error: true });
            } finally {
                if (btn) btn.disabled = false;
            }
        }

        async function openFolder(folder, opts = {}) {
            const section = $("#folder-detail");
            const title = $("#folder-detail-title");
            const sub = $("#folder-detail-sub");
            const items = $("#folder-items");
            if (!section || !items) return;

            const sort = (opts.sort) || ($("#folder-sort") && $("#folder-sort").value) || "created";
            const kind = (opts.kind !== undefined) ? opts.kind : (($("#folder-kind") && $("#folder-kind").value) || "");

            const url = `/library/${encodeURIComponent(folder)}?sort=${encodeURIComponent(sort)}&kind=${encodeURIComponent(kind)}`;
            const r = await fetch(url);
            if (!r.ok) {
                items.innerHTML = `<div class="empty-state empty-state--error">Failed to load folder.</div>`;
                section.hidden = false;
                return;
            }
            const payload = await r.json();
            section.hidden = false;
            section.scrollIntoView({ behavior: "smooth", block: "start" });
            title.textContent = folder;
            if (libState.currentFolder !== folder) {
                libState.selectedStored.clear();
            }
            libState.currentFolder = folder;
            sub.dataset.base = `${payload.total} items · sorted by ${sort}${kind ? ` · ${kind}` : ""}`;
            refreshFolderSubtitle();
            setFolderBulkStatus("");

            if (!payload.items.length) {
                items.innerHTML = `<div class="empty-state">Folder is empty.</div>`;
                return;
            }

            items.innerHTML = payload.items.map((it) => {
                const tags = (it.tags || []).map((t) => `<span class="tag-pill">${t}</span>`).join("");
                const checked = libState.selectedStored.has(it.stored_name) ? "checked" : "";
                return `
                <article class="library-item" data-stored="${it.stored_name}" data-kind="${it.kind || "other"}" data-display="${(it.display_name || it.stored_name)}">
                    <label class="library-item__check" title="Select item">
                        <input type="checkbox" data-action="select" ${checked} />
                    </label>
                    <div class="library-item__icon">${kindBadge(it.kind)}</div>
                    <div class="library-item__body">
                        <h4 class="library-item__name">${it.display_name}</h4>
                        <div class="library-item__meta">
                            <span>${it.stored_name}</span>
                            <span>${fmtBytes(it.size || 0)}</span>
                            <span>${(it.created || "").replace("T", " ").slice(0, 16)}</span>
                            ${it.has_signature || it.has_signature_term ? '<span class="kind-pill kind-pill--sig">SIG</span>' : ""}
                        </div>
                        <div class="library-item__tags">${tags}</div>
                    </div>
                    <div class="library-item__actions">
                        <a class="btn btn--ghost btn--small" href="/library/${encodeURIComponent(folder)}/file/${encodeURIComponent(it.stored_name)}" target="_blank">Open</a>
                        <button class="btn btn--ghost btn--small" data-action="view" type="button">View</button>
                        <button class="btn btn--ghost btn--small" data-action="rename" type="button">Rename</button>
                        <button class="btn btn--ghost btn--small" data-action="delete" type="button">Delete</button>
                    </div>
                </article>`;
            }).join("");

            items.querySelectorAll(".library-item").forEach((row) => {
                const stored = row.dataset.stored;
                const selectCb = row.querySelector('[data-action="select"]');
                if (selectCb) {
                    row.classList.toggle("is-selected", !!selectCb.checked);
                    selectCb.addEventListener("change", () => {
                        if (selectCb.checked) libState.selectedStored.add(stored);
                        else libState.selectedStored.delete(stored);
                        row.classList.toggle("is-selected", !!selectCb.checked);
                        refreshFolderSubtitle();
                    });
                }
                row.querySelector('[data-action="delete"]').addEventListener("click", async () => {
                    if (!confirm(`Delete "${stored}"?`)) return;
                    await fetch(`/library/${encodeURIComponent(folder)}/file/${encodeURIComponent(stored)}`, { method: "DELETE" });
                    libState.selectedStored.delete(stored);
                    openFolder(folder);
                    loadFolders();
                });
                row.querySelector('[data-action="rename"]').addEventListener("click", async () => {
                    const newName = prompt("New display name:", row.querySelector(".library-item__name").textContent);
                    if (!newName) return;
                    const form = new FormData();
                    form.append("stored_name", stored);
                    form.append("display_name", newName);
                    await fetch(`/library/${encodeURIComponent(folder)}/rename`, { method: "POST", body: form });
                    openFolder(folder);
                });
                row.querySelector('[data-action="view"]').addEventListener("click", async () => {
                    const meta = {
                        stored_name: stored,
                        display_name: row.dataset.display || stored,
                        kind: row.dataset.kind || "other",
                    };
                    await renderLibraryPreview(folder, meta);
                });
            });

            refreshFolderSubtitle();
        }

        function refreshLibMeta() {
            const meta = $("#lib-file-meta");
            const metaName = $("#lib-file-meta-name");
            const total = libState.files.length + libState.zipFiles.length;
            if (!meta || !metaName) return;
            meta.hidden = total === 0;
            if (!total) return;

            const size = [...libState.files, ...libState.zipFiles].reduce((s, f) => s + (f.size || 0), 0);
            metaName.textContent = `${total} upload(s) · ${libState.files.length} file(s) + ${libState.zipFiles.length} zip(s) · ${fmtBytes(size)}`;
        }

        function renderLibUploadList() {
            const list = $("#lib-upload-list");
            if (!list) return;
            const total = [...libState.files, ...libState.zipFiles];
            if (!total.length) {
                list.hidden = true;
                list.innerHTML = "";
                return;
            }

            list.hidden = false;
            const chips = [];
            libState.files.forEach((f, idx) => {
                chips.push(`<button type="button" class="upload-chip" data-lib-file-idx="${idx}"><span class="upload-chip__name">${f.name}</span><span class="upload-chip__size">${fmtBytes(f.size)}</span><span class="upload-chip__close" data-lib-file-remove="${idx}">×</span></button>`);
            });
            libState.zipFiles.forEach((f, idx) => {
                chips.push(`<button type="button" class="upload-chip is-active" data-lib-zip-idx="${idx}"><span class="upload-chip__name">${f.name}</span><span class="upload-chip__size">ZIP · ${fmtBytes(f.size)}</span><span class="upload-chip__close" data-lib-zip-remove="${idx}">×</span></button>`);
            });
            list.innerHTML = chips.join("");

            list.querySelectorAll("[data-lib-file-remove]").forEach((btn) => {
                btn.addEventListener("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const idx = Number(btn.getAttribute("data-lib-file-remove"));
                    if (Number.isNaN(idx)) return;
                    libState.files.splice(idx, 1);
                    refreshLibMeta();
                    renderLibUploadList();
                });
            });

            list.querySelectorAll("[data-lib-zip-remove]").forEach((btn) => {
                btn.addEventListener("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const idx = Number(btn.getAttribute("data-lib-zip-remove"));
                    if (Number.isNaN(idx)) return;
                    libState.zipFiles.splice(idx, 1);
                    refreshLibMeta();
                    renderLibUploadList();
                });
            });
        }

        function addLibFiles(fileLike) {
            const incoming = Array.from(fileLike || []);
            if (!incoming.length) return;

            incoming.forEach((f) => {
                const isZip = (f.name || "").toLowerCase().endsWith(".zip");
                if (isZip) libState.zipFiles.push(f);
                else libState.files.push(f);
            });

            refreshLibMeta();
            renderLibUploadList();

            const nameInput = $("#save-name");
            if (nameInput && incoming[0] && !nameInput.value) {
                nameInput.value = incoming[0].name.replace(/\.[^.]+$/, "");
            }
        }

        async function saveToLibrary() {
            const totalUploads = libState.files.length + libState.zipFiles.length;
            if (!totalUploads) {
                setStatus("#lib-save-status", "Pick files or ZIP archives first.", { error: true });
                return;
            }
            const folder = ($("#save-folder") && $("#save-folder").value.trim()) || "default";
            const tags = ($("#save-tags") && $("#save-tags").value.trim()) || "";
            const hadDirectFiles = libState.files.length > 0;
            const form = new FormData();
            libState.files.forEach((f) => form.append("files", f));
            libState.zipFiles.forEach((z) => form.append("zip_files", z));
            form.append("folder", folder);
            form.append("tags", tags);

            const btn = $("#lib-save-btn");
            if (btn) btn.disabled = true;
            setStatus("#lib-save-status", "Uploading... 0%", { busy: true });
            try {
                const r = await xhrFormRequest("/library/save-bulk", form, {
                    responseType: "json",
                    onProgress: (pct) => setStatus("#lib-save-status", `Uploading... ${pct}%`, { busy: true }),
                });
                const payload = r.data;
                const zipFolderTxt = Object.keys(payload.zip_folders || {}).length
                    ? ` ZIP extracted into ${Object.keys(payload.zip_folders).join(", ")}.`
                    : "";
                setStatus("#lib-save-status", `Saved ${payload.saved_count} item(s) into ${payload.base_folder}.${zipFolderTxt}`);
                libState.files = [];
                libState.zipFiles = [];
                refreshLibMeta();
                renderLibUploadList();
                loadFolders();
                const zipFolders = Object.keys(payload.zip_folders || {});
                const openTarget = zipFolders.length && !hadDirectFiles
                    ? zipFolders[0]
                    : payload.base_folder;
                openFolder(openTarget);
            } catch (e) {
                setStatus("#lib-save-status", e.message || "Save failed.", { error: true });
            } finally {
                if (btn) btn.disabled = false;
            }
        }

        async function searchLibrary() {
            const mode = ($("#lib-search-mode") && $("#lib-search-mode").value) || "text";
            const folder = ($("#lib-search-folder") && $("#lib-search-folder").value.trim()) || "";
            const query = ($("#lib-search-query") && $("#lib-search-query").value.trim()) || "";
            const imgInput = $("#lib-search-image");
            const queryImage = imgInput && imgInput.files && imgInput.files[0];

            if (["text", "word", "character", "id"].includes(mode) && !query) {
                setStatus("#lib-search-status", "Enter a query for this mode.", { error: true });
                return;
            }
            if (mode === "image" && !queryImage) {
                setStatus("#lib-search-status", "Pick a query image.", { error: true });
                return;
            }

            const form = new FormData();
            form.append("mode", mode);
            form.append("folder", folder);
            form.append("query", query);
            if (queryImage) form.append("query_image", queryImage);

            const btn = $("#lib-search-btn");
            if (btn) btn.disabled = true;
            setStatus("#lib-search-status", "Searching library...", { busy: true });

            try {
                const r = await fetch("/library/search", { method: "POST", body: form });
                if (!r.ok) throw new Error(`Search failed (${r.status})`);
                const payload = await r.json();
                libState.searchMatches = payload.matches || [];
                libState.selectedSearchKeys = new Set(libState.searchMatches.map((m) => matchKey(m)));
                renderLibrarySearch(payload);
                setSearchMoveStatus("");
                setStatus("#lib-search-status", `${payload.total_matches} match(es) across ${payload.folders_searched.length} folder(s).`);
            } catch (e) {
                setStatus("#lib-search-status", e.message || "Search failed.", { error: true });
            } finally {
                if (btn) btn.disabled = false;
            }
        }

        function renderLibrarySearch(payload) {
            const root = $("#lib-search-results");
            if (!root) return;
            if (!payload.matches || !payload.matches.length) {
                libState.searchMatches = [];
                libState.selectedSearchKeys.clear();
                root.innerHTML = `<div class="empty-state">No matches.</div>`;
                return;
            }
            root.innerHTML = payload.matches.map((m) => `
                <article class="search-item">
                    <div class="search-item__meta">
                        <label class="library-item__check" title="Select result">
                            <input type="checkbox" data-action="select-search" data-key="${m.folder}::${m.stored_name}" ${libState.selectedSearchKeys.has(matchKey(m)) ? "checked" : ""} />
                        </label>
                        ${kindBadge(m.kind)}
                        <span class="search-pill">${m.folder}</span>
                        <span class="search-score">score ${m.score}</span>
                    </div>
                    <h4>${m.display_name}</h4>
                    <p>${m.evidence || ""}</p>
                    <div class="library-item__actions">
                        <a class="btn btn--ghost btn--small" href="/library/${encodeURIComponent(m.folder)}/file/${encodeURIComponent(m.stored_name)}" target="_blank">Open</a>
                        <button class="btn btn--ghost btn--small" data-folder="${m.folder}" data-action="reveal" type="button">Reveal folder</button>
                    </div>
                </article>`).join("");

            root.querySelectorAll('[data-action="reveal"]').forEach((b) => {
                b.addEventListener("click", () => openFolder(b.dataset.folder));
            });
            root.querySelectorAll('input[data-action="select-search"]').forEach((cb) => {
                cb.addEventListener("change", () => {
                    const key = cb.getAttribute("data-key");
                    if (!key) return;
                    if (cb.checked) libState.selectedSearchKeys.add(key);
                    else libState.selectedSearchKeys.delete(key);
                });
            });
        }

        // Dropzone
        if (dz) {
            const fi = $("#lib-file");
            // Keep native <label> behavior; just reset value so reselecting same file works.
            if (fi) fi.addEventListener("click", () => { fi.value = ""; });
            if (fi) {
                fi.addEventListener("change", (e) => {
                    const files = e.target && e.target.files ? e.target.files : null;
                    if (files && files.length) addLibFiles(files);
                });
            }
            ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("is-drag"); }));
            ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("is-drag"); }));
            dz.addEventListener("drop", (e) => {
                const files = e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files : null;
                if (files && files.length) addLibFiles(files);
            });
        }

        // Paste to add
        document.addEventListener("paste", (e) => {
            if (!$("#lib-dropzone")) return;
            const items = (e.clipboardData && e.clipboardData.items) || [];
            for (const it of items) {
                if (it.kind === "file") {
                    const f = it.getAsFile();
                    if (f) addLibFiles([f]);
                }
            }
        });

        const saveBtn = $("#lib-save-btn");
        if (saveBtn) saveBtn.addEventListener("click", saveToLibrary);

        const createFolderBtn = $("#create-folder-btn");
        if (createFolderBtn) {
            createFolderBtn.addEventListener("click", async () => {
                const name = ($("#new-folder-name") && $("#new-folder-name").value.trim()) || "";
                const parent = ($("#new-folder-parent") && $("#new-folder-parent").value.trim()) || "";
                if (!name) return;
                const form = new FormData();
                form.append("name", parent ? `${parent}/${name}` : name);
                await fetch("/library/folder", { method: "POST", body: form });
                $("#new-folder-name").value = "";
                if ($("#new-folder-parent")) $("#new-folder-parent").value = "";
                loadFolders();
            });
        }

        const refreshBtn = $("#refresh-library");
        if (refreshBtn) refreshBtn.addEventListener("click", loadFolders);

        const folderCardsSelectAll = $("#folder-cards-select-all");
        if (folderCardsSelectAll) folderCardsSelectAll.addEventListener("click", () => setAllFolderSelections(true));

        const folderCardsSelectNone = $("#folder-cards-select-none");
        if (folderCardsSelectNone) folderCardsSelectNone.addEventListener("click", () => setAllFolderSelections(false));

        const folderMoveSelectedFolders = $("#folder-move-selected-folders");
        if (folderMoveSelectedFolders) folderMoveSelectedFolders.addEventListener("click", moveSelectedFolders);

        const searchBtn = $("#lib-search-btn");
        if (searchBtn) searchBtn.addEventListener("click", searchLibrary);

        const searchSelectAll = $("#lib-search-select-all");
        if (searchSelectAll) searchSelectAll.addEventListener("click", () => setAllSearchSelections(true));

        const searchSelectNone = $("#lib-search-select-none");
        if (searchSelectNone) searchSelectNone.addEventListener("click", () => setAllSearchSelections(false));

        const searchMoveSelected = $("#lib-search-move-selected");
        if (searchMoveSelected) searchMoveSelected.addEventListener("click", moveSelectedSearchMatches);

        const searchDeleteSelected = $("#lib-search-delete-selected");
        if (searchDeleteSelected) searchDeleteSelected.addEventListener("click", deleteSelectedSearchMatches);

        const folderClose = $("#folder-close");
        if (folderClose) folderClose.addEventListener("click", () => {
            const sect = $("#folder-detail");
            if (sect) sect.hidden = true;
            libState.currentFolder = "";
            libState.selectedStored.clear();
            setFolderBulkStatus("");
        });

        const folderSelectAll = $("#folder-select-all");
        if (folderSelectAll) folderSelectAll.addEventListener("click", () => setVisibleSelection(true));

        const folderSelectNone = $("#folder-select-none");
        if (folderSelectNone) folderSelectNone.addEventListener("click", () => setVisibleSelection(false));

        const folderMoveSelected = $("#folder-move-selected");
        if (folderMoveSelected) folderMoveSelected.addEventListener("click", moveSelectedItems);

        const folderDeleteSelected = $("#folder-delete-selected");
        if (folderDeleteSelected) folderDeleteSelected.addEventListener("click", deleteSelectedItems);

        const folderCreateSub = $("#folder-create-sub");
        if (folderCreateSub) {
            folderCreateSub.addEventListener("click", async () => {
                const current = (libState.currentFolder || "").trim();
                if (!current) {
                    setFolderBulkStatus("Open a folder first.", { error: true });
                    return;
                }
                const subName = prompt("Subfolder name:", "");
                if (!subName) return;
                const form = new FormData();
                form.append("name", `${current}/${subName.trim()}`);
                const r = await fetch("/library/folder", { method: "POST", body: form });
                if (!r.ok) {
                    const payload = await r.json().catch(() => ({}));
                    setFolderBulkStatus(payload.detail || `Create subfolder failed (${r.status})`, { error: true });
                    return;
                }
                setFolderBulkStatus(`Subfolder created under ${current}.`);
                await loadFolders();
            });
        }

        const previewClose = $("#folder-preview-close");
        if (previewClose) previewClose.addEventListener("click", () => {
            const panel = $("#folder-preview");
            const body = $("#folder-preview-body");
            if (panel) panel.hidden = true;
            if (body) body.innerHTML = "";
        });

        const folderExport = $("#folder-export");
        if (folderExport) folderExport.addEventListener("click", () => {
            const folder = $("#folder-detail-title").textContent.trim();
            if (!folder) return;
            const form = new FormData();
            fetch(`/library/${encodeURIComponent(folder)}/export`, { method: "POST", body: form })
                .then((r) => r.blob())
                .then((blob) => {
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url; a.download = `${folder}.zip`; a.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1500);
                });
        });

        ["#folder-sort", "#folder-kind"].forEach((sel) => {
            const el = $(sel);
            if (el) el.addEventListener("change", () => {
                const folder = $("#folder-detail-title").textContent.trim();
                if (folder) openFolder(folder);
            });
        });

        if (grid) loadFolders();
    }

    initDashboardPage();
    initIntelligencePage();
    initLibraryPage();
    initThemeToggle();
    initMobileNav();
    checkHealth();
})();
