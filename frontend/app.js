/* Sanitizer frontend - shared script for dashboard + intelligence pages. */
(() => {
    "use strict";

    const $ = (sel) => document.querySelector(sel);

    const state = {
        file: null,
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
    };

    const IMAGE_EXT = ["jpg", "jpeg", "png", "tif", "tiff", "bmp", "webp"];
    const VIDEO_EXT = ["mp4", "avi", "mov", "mkv", "webm"];
    const TEXT_EXT = ["txt", "csv", "md", "json"];

    function categorize(filename) {
        const ext = (filename.split(".").pop() || "").toLowerCase();
        if (IMAGE_EXT.includes(ext)) return "image";
        if (VIDEO_EXT.includes(ext)) return "video";
        if (TEXT_EXT.includes(ext)) return "text";
        if (ext === "pdf") return "pdf";
        if (ext === "docx") return "docx";
        return "unknown";
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

        function setFile(file) {
            if (!file) return;
            state.file = file;
            state.category = categorize(file.name);

            if (state.beforeUrl) URL.revokeObjectURL(state.beforeUrl);
            state.beforeUrl = URL.createObjectURL(file);

            const meta = $("#file-meta");
            const name = $("#file-name");
            if (meta && name) {
                meta.hidden = false;
                name.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
            }
            runBtn.disabled = false;
            clearStatus();
        }

        function clearFile() {
            state.file = null;
            state.category = null;
            if (state.beforeUrl) URL.revokeObjectURL(state.beforeUrl);
            state.beforeUrl = null;
            fi.value = "";
            const meta = $("#file-meta");
            if (meta) meta.hidden = true;
            runBtn.disabled = true;
        }

        function buildOptions() {
            const kernel = $("#kernel");
            const keywordsEl = $("#keywords");
            const patternsEl = $("#patterns");
            return {
                mask_mode: state.maskMode,
                blur_kernel: kernel ? parseInt(kernel.value, 10) : 51,
                redact_faces: !!($("#opt-faces") && $("#opt-faces").checked),
                redact_numbers: !!($("#opt-numbers") && $("#opt-numbers").checked),
                redact_pii: !!($("#opt-pii") && $("#opt-pii").checked),
                keywords: keywordsEl ? keywordsEl.value.split(",").map((s) => s.trim()).filter(Boolean) : [],
                custom_patterns: patternsEl ? patternsEl.value.split(",").map((s) => s.trim()).filter(Boolean) : [],
                blur_scope: state.blurScope || "exact",
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
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
                    <div>
                        <div style="font-size:12px; color:var(--ink-500); margin-bottom:8px; text-transform:uppercase; letter-spacing:.06em;">Before</div>
                        <iframe src="${state.beforeUrl}" title="Original PDF"></iframe>
                    </div>
                    <div>
                        <div style="font-size:12px; color:var(--ink-500); margin-bottom:8px; text-transform:uppercase; letter-spacing:.06em;">After</div>
                        <iframe src="${state.afterUrl}" title="Sanitized PDF"></iframe>
                    </div>
                </div>`;
            generic.hidden = false;
        }

        async function renderTextSideBySide() {
            const inner = $("#viewer-generic-inner");
            const generic = $("#viewer-generic");
            if (!inner || !generic || !state.afterBlob || !state.file) return;
            const [beforeText, afterText] = await Promise.all([state.file.text(), state.afterBlob.text()]);
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
            } else if (state.category === "text") {
                await renderTextSideBySide();
            } else {
                renderDownloadOnly();
            }

            renderStats(summary);
        }

        async function runSanitize() {
            if (!state.file) return;
            const endpoint = state.category === "video" ? "/sanitize/video" : "/sanitize";
            const form = new FormData();
            form.append("file", state.file);
            form.append("options", JSON.stringify(buildOptions()));

            runBtn.disabled = true;
            setStatus("Sanitizing... this may take a moment on first run.", { busy: true });
            try {
                const res = await fetch(endpoint, { method: "POST", body: form });
                if (!res.ok) {
                    const errText = await res.text().catch(() => "");
                    throw new Error(`API error ${res.status}: ${errText.slice(0, 200)}`);
                }
                const summaryHeader = res.headers.get("X-Sanitizer-Summary");
                const summary = summaryHeader ? JSON.parse(summaryHeader) : null;
                const blob = await res.blob();
                await handleResult(blob, summary);
                setStatus("Done. Compare the result below.");
            } catch (e) {
                setStatus(e.message || "Sanitize failed.", { error: true });
            } finally {
                runBtn.disabled = false;
            }
        }

        dz.addEventListener("click", () => fi.click());
        fi.addEventListener("change", (e) => setFile(e.target.files[0]));
        ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("is-drag"); }));
        ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("is-drag"); }));
        dz.addEventListener("drop", (e) => {
            if (e.dataTransfer.files && e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
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

        const libState = { file: null };

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

        function renderFolders(payload) {
            if (!grid) return;
            const folders = payload.folders || [];
            if (!folders.length) {
                grid.innerHTML = `<div class="empty-state">No folders yet. Create one above or save a file.</div>`;
                return;
            }
            grid.innerHTML = folders.map((f) => `
                <article class="folder-card" data-folder="${f.folder}">
                    <header class="folder-card__head">
                        <div class="folder-card__icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
                            </svg>
                        </div>
                        <h3 class="folder-card__name">${f.folder}</h3>
                    </header>
                    <div class="folder-card__meta">
                        <span>${f.item_count} items</span>
                        <span>${fmtBytes(f.total_size || 0)}</span>
                    </div>
                    <div class="folder-card__kinds">${(f.kinds || []).map((k) => kindBadge(k)).join("")}</div>
                    <div class="folder-card__actions">
                        <button class="btn btn--ghost btn--small" data-action="open" data-folder="${f.folder}" type="button">Open</button>
                        <button class="btn btn--ghost btn--small" data-action="delete" data-folder="${f.folder}" type="button">Delete</button>
                    </div>
                </article>`).join("");

            grid.querySelectorAll("button[data-action]").forEach((btn) => {
                btn.addEventListener("click", async (e) => {
                    e.stopPropagation();
                    const folder = btn.dataset.folder;
                    if (btn.dataset.action === "open") openFolder(folder);
                    else if (btn.dataset.action === "delete") {
                        if (!confirm(`Delete folder "${folder}" and all its items?`)) return;
                        await fetch(`/library/folder/${encodeURIComponent(folder)}`, { method: "DELETE" });
                        loadFolders();
                    }
                });
            });
            grid.querySelectorAll(".folder-card").forEach((card) => {
                card.addEventListener("click", () => openFolder(card.dataset.folder));
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
            sub.textContent = `${payload.total} items · sorted by ${sort}${kind ? ` · ${kind}` : ""}`;

            if (!payload.items.length) {
                items.innerHTML = `<div class="empty-state">Folder is empty.</div>`;
                return;
            }

            items.innerHTML = payload.items.map((it) => {
                const tags = (it.tags || []).map((t) => `<span class="tag-pill">${t}</span>`).join("");
                return `
                <article class="library-item" data-stored="${it.stored_name}">
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
                        <button class="btn btn--ghost btn--small" data-action="rename" type="button">Rename</button>
                        <button class="btn btn--ghost btn--small" data-action="delete" type="button">Delete</button>
                    </div>
                </article>`;
            }).join("");

            items.querySelectorAll(".library-item").forEach((row) => {
                const stored = row.dataset.stored;
                row.querySelector('[data-action="delete"]').addEventListener("click", async () => {
                    if (!confirm(`Delete "${stored}"?`)) return;
                    await fetch(`/library/${encodeURIComponent(folder)}/file/${encodeURIComponent(stored)}`, { method: "DELETE" });
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
            });
        }

        function setLibFile(f) {
            libState.file = f || null;
            const meta = $("#lib-file-meta");
            const metaName = $("#lib-file-meta-name");
            if (meta && metaName) {
                meta.hidden = !f;
                if (f) metaName.textContent = `${f.name} · ${fmtBytes(f.size)}`;
            }
            const nameInput = $("#save-name");
            if (nameInput && f && !nameInput.value) {
                nameInput.value = f.name.replace(/\.[^.]+$/, "");
            }
        }

        async function saveToLibrary() {
            if (!libState.file) {
                setStatus("#lib-save-status", "Pick or paste a file first.", { error: true });
                return;
            }
            const folder = ($("#save-folder") && $("#save-folder").value.trim()) || "default";
            const name = ($("#save-name") && $("#save-name").value.trim()) || "";
            const tags = ($("#save-tags") && $("#save-tags").value.trim()) || "";
            const form = new FormData();
            form.append("file", libState.file);
            form.append("folder", folder);
            form.append("name", name);
            form.append("tags", tags);

            const btn = $("#lib-save-btn");
            if (btn) btn.disabled = true;
            setStatus("#lib-save-status", "Saving to library...", { busy: true });
            try {
                const r = await fetch("/library/save", { method: "POST", body: form });
                if (!r.ok) throw new Error(`Save failed (${r.status})`);
                const payload = await r.json();
                setStatus("#lib-save-status", `Saved ${payload.item.display_name} in folder ${payload.folder}.`);
                loadFolders();
                openFolder(payload.folder);
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
                renderLibrarySearch(payload);
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
                root.innerHTML = `<div class="empty-state">No matches.</div>`;
                return;
            }
            root.innerHTML = payload.matches.map((m) => `
                <article class="search-item">
                    <div class="search-item__meta">
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
        }

        // Dropzone
        if (dz) {
            const fi = $("#lib-file");
            dz.addEventListener("click", () => fi && fi.click());
            if (fi) fi.addEventListener("change", (e) => setLibFile(e.target.files[0]));
            ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("is-drag"); }));
            ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("is-drag"); }));
            dz.addEventListener("drop", (e) => {
                const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
                if (f) setLibFile(f);
            });
        }

        // Paste to add
        document.addEventListener("paste", (e) => {
            if (!$("#lib-dropzone")) return;
            const items = (e.clipboardData && e.clipboardData.items) || [];
            for (const it of items) {
                if (it.kind === "file") {
                    const f = it.getAsFile();
                    if (f) { setLibFile(f); return; }
                }
            }
        });

        const saveBtn = $("#lib-save-btn");
        if (saveBtn) saveBtn.addEventListener("click", saveToLibrary);

        const createFolderBtn = $("#create-folder-btn");
        if (createFolderBtn) {
            createFolderBtn.addEventListener("click", async () => {
                const name = ($("#new-folder-name") && $("#new-folder-name").value.trim()) || "";
                if (!name) return;
                const form = new FormData();
                form.append("name", name);
                await fetch("/library/folder", { method: "POST", body: form });
                $("#new-folder-name").value = "";
                loadFolders();
            });
        }

        const refreshBtn = $("#refresh-library");
        if (refreshBtn) refreshBtn.addEventListener("click", loadFolders);

        const searchBtn = $("#lib-search-btn");
        if (searchBtn) searchBtn.addEventListener("click", searchLibrary);

        const folderClose = $("#folder-close");
        if (folderClose) folderClose.addEventListener("click", () => {
            const sect = $("#folder-detail");
            if (sect) sect.hidden = true;
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
