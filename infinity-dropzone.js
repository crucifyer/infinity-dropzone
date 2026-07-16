/*
Author: shj at xenosi dot de
License: MIT
Source: https://github.com/crucifyer/infinity-dropzone
*/
(function (global) {
	'use strict';

	let i18nMessages = {};
	const I18N_MESSAGES = {
		'ko': {
			'placeholder': '파일을 여기로 드래그하거나 클릭해서 선택하세요',
			'UploadCancelledError': '업로드가 취소되었습니다',
			'UploadFailedError': '업로드 실패',
			'UploadRejectedError': '업로드가 거부되었습니다',
			'ServerResponseParseError': '서버 응답 파싱 실패',
			'NetworkError': '네트워크 에러',
			'progress': '진행률',
			'pending': '대기 중',
			'done': '완료',
			'error': '실패',
			'blocked': '거부됨',
			'duplicate-file': '이미 목록에 있는 파일입니다',
			'extension-not-allowed': '허용되지 않는 확장자입니다',
			'file-too-large': '허용된 최대 용량을 초과했습니다',
			'max-files-reached': '더 이상 추가할 수 없습니다 (최대 개수 초과)',
		},
		'en': {
			'placeholder': 'Drag the file here or click to select it',
			'UploadCancelledError': 'Upload canceled',
			'UploadFailedError': 'Upload failed',
			'UploadRejectedError': 'Upload rejected',
			'ServerResponseParseError': 'Failed to parse server response',
			'NetworkError': 'Network error',
			'progress': 'Progress',
			'pending': 'Pending',
			'done': 'Done',
			'error': 'Error',
			'blocked': 'Blocked',
			'duplicate-file': 'This file is already in the list',
			'extension-not-allowed': 'Unallowed file extension',
			'file-too-large': 'Exceeds the maximum allowed size',
			'max-files-reached': 'Cannot add any more (maximum number exceeded)',
		},
	};
	function getI18nMessage(key) {
		return i18nMessages[key] || I18N_MESSAGES[navigator.language]?.[key] || I18N_MESSAGES[navigator.language.split('-')[0]]?.[key] || I18N_MESSAGES.en[key] || key;
	}

	const MAX_CONCURRENT_UPLOADS = 2;
	const MAX_CHUNK_SIZE = 90 * 1024 * 1024;
	const COMPRESSIBLE_EXTS = ['txt', 'csv', 'css', 'js', 'json', 'md', 'svg', 'ini', 'toml', 'yml'];

	class UploadCancelledError extends Error {
		constructor() {
			super(getI18nMessage( 'UploadCancelledError'));
			this.name = 'UploadCancelledError';
		}
	}

	function createCancelToken() {
		return {
			cancelled: false,
			xhr: null,
			cancel() {
				this.cancelled = true;
				if (this.xhr) {
					this.xhr.abort();
				}
			},
			throwIfCancelled() {
				if (this.cancelled) throw new UploadCancelledError();
			},
		};
	}

	function createByteAccumulator() {
		let chunks = [];
		let length = 0;

		return {
			get length() {
				return length;
			},
			push(chunk) {
				chunks.push(chunk);
				length += chunk.length;
			},
			takeExact(size) {
				const out = new Uint8Array(size);
				let offset = 0;
				while (offset < size) {
					const head = chunks[0];
					const need = size - offset;
					if (head.length <= need) {
						out.set(head, offset);
						offset += head.length;
						chunks.shift();
					} else {
						out.set(head.subarray(0, need), offset);
						chunks[0] = head.subarray(need);
						offset += need;
					}
				}
				length -= size;
				return out;
			},
			takeRemaining() {
				return this.takeExact(length);
			},
		};
	}

	async function streamUpload(uploadUrl, { sessionId, fileKey, ext, compressed, stream }, onFileProgress, cancelToken) {
		const reader = stream.getReader();
		const acc = createByteAccumulator();
		let partIndex = 0;
		let sentAnyPart = false;
		let completedChunksBytes = 0;

		try {
			for (;;) {
				cancelToken.throwIfCancelled();
				const { value, done } = await reader.read();
				if (value) acc.push(value);

				while (acc.length >= MAX_CHUNK_SIZE) {
					cancelToken.throwIfCancelled();
					const partBytes = acc.takeExact(MAX_CHUNK_SIZE);
					const partSize = partBytes.length;
					await sendPart(uploadUrl, {
						sessionId,
						fileKey,
						ext,
						compressed,
						partIndex,
						isSingle: false,
						blob: new Blob([partBytes]),
					}, (loaded) => {
						if (onFileProgress) onFileProgress(completedChunksBytes + loaded);
					}, cancelToken);
					completedChunksBytes += partSize;
					sentAnyPart = true;
					partIndex++;
				}

				if (done) break;
			}

			const remaining = acc.takeRemaining();

			if (!sentAnyPart) {
				return await sendPart(uploadUrl, {
					sessionId,
					fileKey,
					ext,
					compressed,
					partIndex: 0,
					isSingle: true,
					blob: new Blob([remaining]),
				}, (loaded) => {
					if (onFileProgress) onFileProgress(loaded);
				}, cancelToken);
			}

			if (remaining.length > 0) {
				const partSize = remaining.length;
				await sendPart(uploadUrl, {
					sessionId,
					fileKey,
					ext,
					compressed,
					partIndex,
					isSingle: false,
					blob: new Blob([remaining]),
				}, (loaded) => {
					if (onFileProgress) onFileProgress(completedChunksBytes + loaded);
				}, cancelToken);
				completedChunksBytes += partSize;
			}

			cancelToken.throwIfCancelled();
			return await sendComplete(uploadUrl, { sessionId, fileKey, compressed }, cancelToken);
		} catch (err) {
			reader.cancel().catch(() => {});
			throw err;
		}
	}

	function getExt(filename) {
		const extmatch = filename.match(/\.([\da-z]{1,20})$/i);
		if (extmatch) return extmatch[1].toLowerCase();
		return 'unknown';
	}

	function formatBytes(bytes) {
		if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
		const units = ['B', 'KB', 'MB', 'GB', 'TB'];
		const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
		const value = bytes / Math.pow(1024, i);
		return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
	}

	function postForm(uploadUrl, fields, onProgress, cancelToken) {
		return new Promise((resolve, reject) => {
			if (cancelToken && cancelToken.cancelled) {
				reject(new UploadCancelledError());
				return;
			}

			const xhr = new XMLHttpRequest();
			xhr.open('POST', uploadUrl);

			if (cancelToken) cancelToken.xhr = xhr;

			if (onProgress && xhr.upload) {
				xhr.upload.addEventListener('progress', (e) => {
					if (e.lengthComputable) onProgress(e.loaded, e.total);
				});
			}

			xhr.onload = () => {
				if (cancelToken) cancelToken.xhr = null;
				if (xhr.status >= 200 && xhr.status < 300) {
					try {
						const json = JSON.parse(xhr.responseText);
						if (json.status === 200) {
							resolve(json);
						} else {
							reject(new Error(json.error || `${getI18nMessage('UploadFailedError')} (status=${json.status})`));
						}
					} catch (e) {
						reject(new Error(getI18nMessage('ServerResponseParseError')));
					}
				} else {
					reject(new Error(`${getI18nMessage('UploadFailedError')} (status=${xhr.status})`));
				}
			};

			xhr.onerror = () => {
				if (cancelToken) cancelToken.xhr = null;
				reject(new Error(getI18nMessage('NetworkError')));
			};

			xhr.onabort = () => {
				if (cancelToken) cancelToken.xhr = null;
				reject(new UploadCancelledError());
			};

			const fd = new FormData();
			for (const [k, v] of Object.entries(fields)) {
				fd.append(k, v);
			}
			xhr.send(fd);
		});
	}

	function sendPart(uploadUrl, { sessionId, fileKey, ext, compressed, partIndex, isSingle, blob }, onProgress, cancelToken) {
		return postForm(uploadUrl, {
			sessionId,
			fileKey,
			ext,
			compressed: compressed ? '1' : '0',
			action: isSingle ? 'single' : 'part',
			partIndex: String(partIndex),
			chunk: new File([blob], fileKey + '.part' + partIndex),
		}, onProgress, cancelToken);
	}

	function sendComplete(uploadUrl, { sessionId, fileKey, compressed }, cancelToken) {
		return postForm(uploadUrl, {
			sessionId,
			fileKey,
			compressed: compressed ? '1' : '0',
			action: 'complete',
		}, null, cancelToken);
	}

	function fileSignature(file) {
		return `${file.name}-${file.size}-${file.lastModified}`;
	}

	const STATUS_ORDER = { done: 0, error: 1, blocked: 1, uploading: 2, pending: 3 };

	function makeDropzone(selector, uploadUrl, options) {
		const normalizedAllowed = options?.allowedExts && Array.isArray(options.allowedExts) && options.allowedExts.length
			? options.allowedExts.map((e) => String(e).toLowerCase())
			: null;
		const maxFileSize = options?.maxFileSize ?? Infinity;
		const maxFiles = options?.maxFiles ?? Infinity;
		if(options?.i18nMessages) i18nMessages = options.i18nMessages;

		document.querySelectorAll(selector).forEach((dzone) => {
			const zone = dzone.querySelector('.zonebox');
			const input = zone.querySelector('input[type=file]');
			const labelEl = zone.querySelector('.dz-label');
			const fileKeysInput = dzone.querySelector('input[name="fileKeys"]');
			const filesContainer = dzone.querySelector('.files');

			const originalLabelText = getI18nMessage('placeholder');
			if(labelEl) labelEl.textContent = originalLabelText;

			const sessionId = crypto.randomUUID();

			const fileStates = new Map();
			let sequence = 0;

			let activeCount = 0;
			const pendingQueue = [];

			const signatures = new Map();

			function emit(name, detail) {
				zone.dispatchEvent(new CustomEvent(name, { detail }));
			}

			function isBusy() {
				return activeCount > 0 || pendingQueue.length > 0;
			}

			function syncBusyClass() {
				zone.classList.toggle('uploading', isBusy());
				updateOverallLabel();
			}

			function computeOverallProgress() {
				let loaded = 0;
				let total = 0;
				let count = 0;
				let doneCount = 0;

				for (const s of fileStates.values()) {
					if (s.status === 'blocked') continue;
					count++;
					total += s.totalBytes;
					if (s.status === 'done') {
						loaded += s.totalBytes;
						doneCount++;
					} else {
						loaded += s.loadedBytes;
					}
				}

				return { loaded, total, count, doneCount };
			}

			function updateOverallLabel() {
				if (!labelEl) return;

				const { loaded, total, count, doneCount } = computeOverallProgress();

				if (count === 0) {
					labelEl.textContent = originalLabelText;
					return;
				}

				const percent = total > 0 ? Math.round((loaded / total) * 100) : 100;
				labelEl.textContent = `${getI18nMessage('progress')} ${percent}% (${doneCount}/${count} ${getI18nMessage('done')})`;
			}

			function updateFileKeysInput() {
				if (!fileKeysInput) return;
				const files = Array.from(fileStates.values())
					.filter((s) => s.status === 'done')
					.map((s) => ({ name: s.originalName, key: s.fileKey, checksum: s.checksum }));
				fileKeysInput.value = JSON.stringify({ sessionId, files });
			}

			function resort() {
				const states = Array.from(fileStates.values());
				states.sort((a, b) => {
					const diff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
					if (diff !== 0) return diff;
					return a.sequence - b.sequence;
				});
				for (const s of states) {
					filesContainer.appendChild(s.rowEl);
				}
			}

			function refreshStatusLabel(state) {
				switch (state.status) {
					case 'pending':
						state.percentEl.textContent = getI18nMessage(state.status);
						state.barFillEl.style.width = '0%';
						break;
					case 'uploading':
						updateProgress(state, state.loadedBytes);
						break;
					case 'done':
						state.barFillEl.style.width = '100%';
						state.percentEl.textContent = getI18nMessage(state.status);
						break;
					case 'error':
						state.percentEl.textContent = getI18nMessage(state.status);
						break;
					case 'blocked':
						state.percentEl.textContent = getI18nMessage(state.status);
						state.barFillEl.style.width = '100%';
						break;
				}
			}

			function setStatus(state, status) {
				state.status = status;
				state.rowEl.className = 'file-item status-' + status;
				refreshStatusLabel(state);
				resort();
				syncBusyClass();
			}

			function updateProgress(state, loadedBytes) {
				state.loadedBytes = loadedBytes;
				const total = state.totalBytes || 1;
				const percent = Math.max(0, Math.min(100, (loadedBytes / total) * 100));
				state.barFillEl.style.width = percent.toFixed(0) + '%';
				state.percentEl.textContent = percent.toFixed(0) + '%';
				updateOverallLabel();
			}

			function createRow(state) {
				const row = document.createElement('div');
				row.className = 'file-item status-' + state.status;

				const top = document.createElement('div');
				top.className = 'file-item-top';

				const nameEl = document.createElement('span');
				nameEl.className = 'file-name';
				nameEl.textContent = state.originalName;
				nameEl.title = state.originalName;

				const sizeEl = document.createElement('span');
				sizeEl.className = 'file-size';
				sizeEl.textContent = formatBytes(state.totalBytes);

				const removeBtn = document.createElement('button');
				removeBtn.type = 'button';
				removeBtn.className = 'remove-btn';
				removeBtn.textContent = 'x';
				removeBtn.addEventListener('click', () => removeFile(state.fileKey));

				top.append(nameEl, sizeEl, removeBtn);

				const barOuter = document.createElement('div');
				barOuter.className = 'file-progress-bar';
				const barFill = document.createElement('div');
				barFill.className = 'file-progress-fill';
				barOuter.appendChild(barFill);

				const percentEl = document.createElement('div');
				percentEl.className = 'file-percent';
				percentEl.textContent = '0%';

				const errorEl = document.createElement('div');
				errorEl.className = 'file-error-message';

				row.append(top, barOuter, percentEl, errorEl);
				filesContainer.appendChild(row);

				state.rowEl = row;
				state.barFillEl = barFill;
				state.percentEl = percentEl;
				state.errorEl = errorEl;
			}

			function removeFile(fileKey) {
				const state = fileStates.get(fileKey);
				if (!state) return;

				if (state.status === 'pending' || state.status === 'uploading') {
					state.cancelToken.cancel();
					const idx = pendingQueue.indexOf(fileKey);
					if (idx >= 0) pendingQueue.splice(idx, 1);
				}

				if (state.signature && signatures.get(state.signature) === fileKey) {
					signatures.delete(state.signature);
				}

				state.rowEl.remove();
				fileStates.delete(fileKey);
				updateFileKeysInput();
				syncBusyClass();
			}

			['dragenter', 'dragover'].forEach((evt) => {
				zone.addEventListener(evt, (e) => {
					e.preventDefault();
					e.stopPropagation();
					zone.classList.add('dropping');
				});
			});
			['dragleave', 'drop'].forEach((evt) => {
				zone.addEventListener(evt, (e) => {
					e.preventDefault();
					e.stopPropagation();
					zone.classList.remove('dropping');
				});
			});

			zone.addEventListener('drop', (e) => {
				const files = Array.from(e.dataTransfer.files || []);
				handleFiles(files);
			});

			if (input) {
				zone.addEventListener('click', (e) => {
					if (e.target !== input) input.click();
				});
				input.addEventListener('change', (e) => {
					handleFiles(Array.from(e.target.files || []));
					input.value = '';
				});
			}

			function addBlockedEntry(file, reason, signature) {
				const fileKey = crypto.randomUUID() + '.blocked';
				const state = {
					fileKey,
					file,
					ext: getExt(file.name),
					originalName: file.name,
					totalBytes: file.size,
					loadedBytes: 0,
					status: 'blocked',
					cancelToken: createCancelToken(),
					sequence: sequence++,
					checksum: null,
					signature: signature || null,
				};

				fileStates.set(fileKey, state);
				createRow(state);
				state.errorEl.textContent = getI18nMessage(reason) || getI18nMessage('UploadRejectedError');
				refreshStatusLabel(state);
				resort();

				emit('dropzone:rejected', { file, reason });
			}

			function handleFiles(files) {
				for (const file of files) {
					const signature = fileSignature(file);
					if (signatures.has(signature)) {
						addBlockedEntry(file, 'duplicate-file', signature);
						continue;
					}

					const ext = getExt(file.name);

					if (normalizedAllowed && !normalizedAllowed.includes(ext)) {
						addBlockedEntry(file, 'extension-not-allowed');
						continue;
					}
					if (file.size > maxFileSize) {
						addBlockedEntry(file, 'file-too-large');
						continue;
					}
					const trackedCount = Array.from(fileStates.values()).filter((s) => s.status !== 'blocked').length;
					if (trackedCount >= maxFiles) {
						addBlockedEntry(file, 'max-files-reached');
						continue;
					}

					const fileKey = crypto.randomUUID() + (ext ? '.' + ext : '');
					const state = {
						fileKey,
						file,
						ext,
						originalName: file.name,
						totalBytes: file.size,
						loadedBytes: 0,
						status: 'pending',
						cancelToken: createCancelToken(),
						sequence: sequence++,
						checksum: null,
						signature,
					};

					signatures.set(signature, fileKey);
					fileStates.set(fileKey, state);
					createRow(state);
					resort();

					emit('dropzone:queued', { file, fileKey, sessionId });

					pendingQueue.push(fileKey);
				}

				syncBusyClass();
				pump();
			}

			function pump() {
				while (activeCount < MAX_CONCURRENT_UPLOADS && pendingQueue.length > 0) {
					const fileKey = pendingQueue.shift();
					const state = fileStates.get(fileKey);
					if (!state) continue;
					startUpload(state);
				}
				syncBusyClass();
			}

			function startUpload(state) {
				activeCount++;
				setStatus(state, 'uploading');
				state.rowEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

				uploadFile(state)
					.then((result) => {
						if (!fileStates.has(state.fileKey)) return;
						state.checksum = result.checksum || null;
						setStatus(state, 'done');
						updateFileKeysInput();
						emit('dropzone:complete', {
							file: state.file,
							fileKey: state.fileKey,
							originalName: state.originalName,
							result,
						});
					})
					.catch((err) => {
						if (!fileStates.has(state.fileKey)) return;
						if (err && err.name === 'UploadCancelledError') return;
						setStatus(state, 'error');
						state.errorEl.textContent = err.message || '업로드 실패';
						emit('dropzone:error', { file: state.file, fileKey: state.fileKey, error: err });
					})
					.finally(() => {
						activeCount--;
						pump();
					});
			}

			async function uploadFile(state) {
				const { file, ext, fileKey, cancelToken } = state;
				const shouldCompress = COMPRESSIBLE_EXTS.includes(ext) && typeof CompressionStream !== 'undefined';
				const compressed = shouldCompress;
				const stream = shouldCompress
					? file.stream().pipeThrough(new CompressionStream('gzip'))
					: file.stream();

				return streamUpload(
					uploadUrl,
					{ sessionId, fileKey, ext, compressed, stream },
					(loadedBytes) => updateProgress(state, loadedBytes),
					cancelToken
				);
			}
		});
	}

	global.makeDropzone = makeDropzone;
})(window);
