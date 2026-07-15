/*
Author: shj at xenosi dot de
License: MIT
Source: https://github.com/crucifyer/infinity-dropzone
*/
(function (global) {
	'use strict';

	const MAX_CONCURRENT_UPLOADS = 2;
	const MAX_CHUNK_SIZE = 90 * 1024 * 1024;
	const COMPRESSIBLE_EXTS = ['txt', 'csv', 'css', 'js', 'json', 'md', 'svg', 'ini', 'toml', 'yml'];

	function createUploadQueue(concurrency) {
		let active = 0;
		const queue = [];

		function runNext() {
			if (active >= concurrency || queue.length === 0) return;
			active++;
			const { task, resolve, reject } = queue.shift();
			Promise.resolve()
				.then(task)
				.then(resolve, reject)
				.finally(() => {
					active--;
					runNext();
				});
		}

		return {
			add(task) {
				return new Promise((resolve, reject) => {
					queue.push({ task, resolve, reject });
					runNext();
				});
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

	async function streamUpload(uploadUrl, uploadQueue, { sessionId, fileKey, ext, compressed, stream }, onFileProgress) {
		const reader = stream.getReader();
		const acc = createByteAccumulator();
		let partIndex = 0;
		let sentAnyPart = false;
		let completedChunksBytes = 0;

		for (;;) {
			const { value, done } = await reader.read();
			if (value) acc.push(value);

			while (acc.length >= MAX_CHUNK_SIZE) {
				const partBytes = acc.takeExact(MAX_CHUNK_SIZE);
				const partSize = partBytes.length;
				await uploadQueue.add(() =>
					sendPart(uploadUrl, {
						sessionId,
						fileKey,
						ext,
						compressed,
						partIndex,
						isSingle: false,
						blob: new Blob([partBytes]),
					}, (loaded, total) => {
						if (onFileProgress) {
							onFileProgress(completedChunksBytes + loaded);
						}
					})
				);
				completedChunksBytes += partSize;
				sentAnyPart = true;
				partIndex++;
			}

			if (done) break;
		}

		const remaining = acc.takeRemaining();

		if (!sentAnyPart) {
			return uploadQueue.add(() =>
				sendPart(uploadUrl, {
					sessionId,
					fileKey,
					ext,
					compressed,
					partIndex: 0,
					isSingle: true,
					blob: new Blob([remaining]),
				}, (loaded, total) => {
					if (onFileProgress) {
						onFileProgress(loaded);
					}
				})
			);
		}

		if (remaining.length > 0) {
			const partSize = remaining.length;
			await uploadQueue.add(() =>
				sendPart(uploadUrl, {
					sessionId,
					fileKey,
					ext,
					compressed,
					partIndex,
					isSingle: false,
					blob: new Blob([remaining]),
				}, (loaded, total) => {
					if (onFileProgress) {
						onFileProgress(completedChunksBytes + loaded);
					}
				})
			);
			completedChunksBytes += partSize;
		}

		return uploadQueue.add(() => sendComplete(uploadUrl, { sessionId, fileKey, compressed }));
	}

	function getExt(filename) {
		const extmatch = filename.match(/\.([\da-z]{1,20})$/i);
		if (extmatch) return extmatch[1].toLowerCase();
		return 'unknown';
	}

	function postForm(uploadUrl, fields, onProgress) {
		return new Promise((resolve, reject) => {
			const xhr = new XMLHttpRequest();
			xhr.open('POST', uploadUrl);

			if (onProgress && xhr.upload) {
				xhr.upload.addEventListener('progress', (e) => {
					if (e.lengthComputable) {
						onProgress(e.loaded, e.total);
					}
				});
			}

			xhr.onload = () => {
				if (xhr.status >= 200 && xhr.status < 300) {
					try {
						const json = JSON.parse(xhr.responseText);
						if (json.status === 200) {
							resolve(json);
						} else {
							reject(new Error(json.error || `업로드 실패 (status=${json.status})`));
						}
					} catch (e) {
						reject(new Error('서버 응답 파싱 실패'));
					}
				} else {
					reject(new Error(`업로드 실패 (status=${xhr.status})`));
				}
			};

			xhr.onerror = () => reject(new Error('네트워크 에러'));

			const fd = new FormData();
			for (const [k, v] of Object.entries(fields)) {
				fd.append(k, v);
			}
			xhr.send(fd);
		});
	}

	function sendPart(uploadUrl, { sessionId, fileKey, ext, compressed, partIndex, isSingle, blob }, onProgress) {
		return postForm(uploadUrl, {
			sessionId,
			fileKey,
			ext,
			compressed: compressed ? '1' : '0',
			action: isSingle ? 'single' : 'part',
			partIndex: String(partIndex),
			chunk: new File([blob], fileKey + '.part' + partIndex),
		}, onProgress);
	}

	function sendComplete(uploadUrl, { sessionId, fileKey, compressed }) {
		return postForm(uploadUrl, {
			sessionId,
			fileKey,
			compressed: compressed ? '1' : '0',
			action: 'complete',
		});
	}

	function makeDropzone(selector, uploadUrl, options) {
		const normalizedAllowed = options?.allowedExts && Array.isArray(options.allowedExts) && options.allowedExts.length
			? options.allowedExts.map((e) => String(e).toLowerCase())
			: null;
		const maxFileSize = options?.maxFileSize ?? Infinity;
		const maxFiles = options?.maxFiles ?? Infinity;

		document.querySelectorAll(selector).forEach((dzone) => {
			const zone = dzone.querySelector('.zonebox');
			const input = zone.querySelector('input[type=file]');
			const fileKeysInput = dzone.querySelector('input[name="fileKeys"]');
			const filesContainer = dzone.querySelector('.files');

			let isUploading = false;
			const uploadedFiles = []; // [{"name":fileName,"key":fileKey}]

			const sessionId = crypto.randomUUID();

			const fileNameMap = new Map();

			const uploadQueue = createUploadQueue(MAX_CONCURRENT_UPLOADS);

			function updateFileList() {
				if (fileKeysInput) {
					fileKeysInput.value = JSON.stringify({sessionId, files:uploadedFiles});
				}
				if (filesContainer) {
					filesContainer.innerHTML = '';
					uploadedFiles.forEach((file, index) => {
						const item = document.createElement('div');
						item.className = 'file-item';

						const nameSpan = document.createElement('span');
						nameSpan.textContent = file.name;

						const removeBtn = document.createElement('button');
						removeBtn.type = 'button';
						removeBtn.className = 'remove-btn';
						removeBtn.textContent = 'x';
						removeBtn.addEventListener('click', () => {
							uploadedFiles.splice(index, 1);
							updateFileList();
						});

						item.appendChild(nameSpan);
						item.appendChild(removeBtn);
						filesContainer.appendChild(item);
					});
				}
			}

			['dragenter', 'dragover'].forEach((evt) => {
				zone.addEventListener(evt, (e) => {
					e.preventDefault();
					e.stopPropagation();
					if (isUploading) return;
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
				if (isUploading) return;
				const files = Array.from(e.dataTransfer.files || []);
				handleFiles(files);
			});

			if (input) {
				zone.addEventListener('click', (e) => {
					if (isUploading) return;
					if (e.target !== input) input.click();
				});
				input.addEventListener('change', (e) => {
					if (isUploading) return;
					handleFiles(Array.from(e.target.files || []));
					input.value = '';
				});
			}

			function emit(name, detail) {
				zone.dispatchEvent(new CustomEvent(name, { detail }));
			}

			function handleFiles(files) {
				if (isUploading) return;

				const filesToUpload = [];
				for (const file of files) {
					const ext = getExt(file.name);

					if (normalizedAllowed && !normalizedAllowed.includes(ext)) {
						emit('dropzone:rejected', { file, reason: 'extension-not-allowed' });
						continue;
					}
					if (file.size > maxFileSize) {
						emit('dropzone:rejected', { file, reason: 'file-too-large' });
						continue;
					}
					if (uploadedFiles.length >= maxFiles) {
						emit('dropzone:rejected', { file, reason: 'max-files-reached' });
						continue;
					}
					filesToUpload.push(file);
				}

				if (filesToUpload.length === 0) return;

				isUploading = true;
				zone.classList.add('uploading');

				const originalText = '파일을 여기로 드래그하거나 클릭해서 선택하세요';
				zone.textContent = '업로드 중... (0%)';

				const totalBatchSize = filesToUpload.reduce((sum, f) => sum + f.size, 0);
				const progressMap = new Map(); // fileKey -> loadedBytes
				let pendingCount = filesToUpload.length;

				function updateBatchProgress() {
					let loadedSum = 0;
					for (const loaded of progressMap.values()) {
						loadedSum += loaded;
					}
					const percent = totalBatchSize > 0 ? Math.min(100, Math.round((loadedSum / totalBatchSize) * 100)) : 0;
					zone.textContent = `업로드 중... (${percent}%)`;
				}

				function checkBatchComplete() {
					pendingCount--;
					if (pendingCount === 0) {
						isUploading = false;
						zone.classList.remove('uploading');
						zone.textContent = originalText;
						if (input) input.value = '';
					}
				}

				for (const file of filesToUpload) {
					const ext = getExt(file.name);
					const fileKey = crypto.randomUUID() + (ext ? '.' + ext : '');
					fileNameMap.set(fileKey, file.name);

					emit('dropzone:queued', { file, fileKey, sessionId });

					progressMap.set(fileKey, 0);

					uploadFile(file, fileKey, ext, (loadedBytes) => {
						progressMap.set(fileKey, loadedBytes);
						updateBatchProgress();
					})
						.then((result) => {
							uploadedFiles.push({ name: file.name, key: fileKey });
							updateFileList();

							emit('dropzone:complete', {
								file,
								fileKey,
								originalName: fileNameMap.get(fileKey),
								result,
							});
						})
						.catch((err) => {
							emit('dropzone:error', { file, fileKey, error: err });
						})
						.finally(() => {
							checkBatchComplete();
						});
				}
			}

			async function uploadFile(file, fileKey, ext, onProgress) {
				const shouldCompress =
					COMPRESSIBLE_EXTS.includes(ext) && typeof CompressionStream !== 'undefined';

				const compressed = shouldCompress;
				const stream = shouldCompress
					? file.stream().pipeThrough(new CompressionStream('gzip'))
					: file.stream();

				const result = await streamUpload(uploadUrl, uploadQueue, {
					sessionId,
					fileKey,
					ext,
					compressed,
					stream,
				}, onProgress);

				return result;
			}
		});
	}

	global.makeDropzone = makeDropzone;
})(window);