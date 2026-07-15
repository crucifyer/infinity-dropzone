<?php

header('Content-Type: application/json; charset=utf-8');

set_time_limit(300);

function respond($status, $extra = []) {
	http_response_code($status >= 200 && $status < 600 ? $status : 500);
	echo json_encode(array_merge(['status' => $status], $extra));
	exit;
}

function fail($status, $message) {
	respond($status, ['error' => $message]);
}

function ensureDir($dir) {
	if (!is_dir($dir) && !mkdir($dir, 0755, true) && !is_dir($dir)) {
		throw new RuntimeException("디렉토리 생성 실패: {$dir}");
	}
}

function mergeParts($dir, $mergedPath) {
	$files = glob($dir.'/*.part');
	if ($files === false || count($files) === 0) {
		throw new RuntimeException('합칠 조각을 찾을 수 없습니다.');
	}
	natsort($files);

	$out = fopen($mergedPath, 'wb');
	if ($out === false) {
		throw new RuntimeException('병합 파일 생성 실패');
	}
	foreach ($files as $partFile) {
		$in = fopen($partFile, 'rb');
		if ($in === false) {
			fclose($out);
			throw new RuntimeException("조각 파일 열기 실패: {$partFile}");
		}
		stream_copy_to_stream($in, $out);
		fclose($in);
	}
	fclose($out);
}

function decompressGzipFile($srcPath, $destPath) {
	$in = fopen($srcPath, 'rb');
	if ($in === false) {
		throw new RuntimeException('압축 파일 열기 실패');
	}
	// window = 15 + 16 -> gzip(헤더 포함) 형식으로 해석
	if (stream_filter_append($in, 'zlib.inflate', STREAM_FILTER_READ, ['window' => 15 + 16]) === false) {
		fclose($in);
		throw new RuntimeException('압축 해제 필터 적용 실패');
	}
	$out = fopen($destPath, 'wb');
	if ($out === false) {
		fclose($in);
		throw new RuntimeException('압축 해제 결과 파일 생성 실패');
	}
	if (stream_copy_to_stream($in, $out) === false) {
		fclose($in);
		fclose($out);
		throw new RuntimeException('압축 해제 중 오류');
	}
	fclose($in);
	fclose($out);
}

function rrmdir($dir) {
	if (!is_dir($dir)) return;
	$items = scandir($dir);
	foreach ($items as $item) {
		if ($item === '.' || $item === '..') continue;
		$path = $dir.'/'.$item;
		is_dir($path) ? rrmdir($path) : unlink($path);
	}
	rmdir($dir);
}

try {
	if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
		fail(405, 'POST 요청만 허용됩니다.');
	}

	if(!isset($_POST['sessionId'], $_POST['fileKey'], $_POST['action'])) fail(400, '잘못된 요청 입니다.');
	$sessionId = $_POST['sessionId'];
	$fileKey = $_POST['fileKey'];
	$action = $_POST['action'];
	if (!preg_match('/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i', $sessionId)) {
		fail(400, 'sessionId 형식이 올바르지 않습니다.');
	}
	if (!preg_match('/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.[\da-z]{1,20}$/i', $fileKey)) {
		fail(400, 'fileKey 형식이 올바르지 않습니다.');
	}

	define('ALLOWED_EXTENSIONS', ['jpg', 'jpeg', 'png', 'gz', 'bz2', 'iso', 'txt', 'csv', 'js', 'json', 'md', 'svg']);
	// 두 임시 디렉토리는 최종 저장될 디렉토리와 같은 마운트 포인트로 맞춰야 합니다.
	define('TMP_DIR', '/tmp/dropzone/tmp/'.$sessionId);
	define('FINAL_DIR', '/tmp/dropzone/final/'.$sessionId);

	ensureDir(TMP_DIR);
	ensureDir(FINAL_DIR);

	$ext = strtolower(pathinfo($fileKey, PATHINFO_EXTENSION));
	if (!in_array($ext, ALLOWED_EXTENSIONS, true)) {
		fail(400, "허용되지 않는 확장자입니다: {$ext}");
	}

	switch ($action) {
		case 'part':
			if (!isset($_FILES['chunk']) || $_FILES['chunk']['error'] !== UPLOAD_ERR_OK) {
				fail(400, '조각 파일 업로드 실패');
			}
			if(!isset($_POST['partIndex'], $_POST['compressed']) || !preg_match('/^\d+$/', $_POST['partIndex'])) {
				fail(400, '잘못된 요청 입니다.');
			}
			$partIndex = $_POST['partIndex'];

			$dir = TMP_DIR.'/'.$fileKey;
			ensureDir($dir);

			$dest = $dir.'/'.sprintf('%08d', $partIndex).'.part';
			if (!move_uploaded_file($_FILES['chunk']['tmp_name'], $dest)) {
				fail(500, '조각 파일 저장 실패');
			}

			file_put_contents($dir.'/.compressed', $_POST['compressed'] === '1' ? '1' : '0');

			respond(200);

		case 'single':
			if (!isset($_FILES['chunk']) || $_FILES['chunk']['error'] !== UPLOAD_ERR_OK) {
				fail(400, '파일 업로드 실패');
			}
			if(!isset($_POST['partIndex'], $_POST['compressed']) || '0' !== $_POST['partIndex'] || !preg_match('/^[01]$/', $_POST['compressed'])) {
				fail(400, '잘못된 요청 입니다.');
			}
			$compressed = $_POST['compressed'] === '1';
			$finalPath = FINAL_DIR.'/'.$fileKey;

			if ($compressed) {
				decompressGzipFile($_FILES['chunk']['tmp_name'], $finalPath);
			} else {
				if (!move_uploaded_file($_FILES['chunk']['tmp_name'], $finalPath)) {
					fail(500, '파일 저장 실패');
				}
			}
			respond(200, ['fileKey' => $fileKey]);

		case 'complete':
			$dir = TMP_DIR.'/'.$fileKey;
			if (!is_dir($dir)) {
				fail(400, '해당 fileKey로 업로드된 조각이 없습니다.');
			}

			$compressed = false;
			if (is_file($dir.'/.compressed')) {
				$compressed = trim((string) file_get_contents($dir.'/.compressed')) === '1';
			}

			$mergedPath = TMP_DIR.'/'.$fileKey.'.merged';
			mergeParts($dir, $mergedPath);

			$finalPath = FINAL_DIR.'/'.$fileKey;
			if ($compressed) {
				decompressGzipFile($mergedPath, $finalPath);
				unlink($mergedPath);
			} else {
				if (!rename($mergedPath, $finalPath)) {
					fail(500, '최종 파일 이동 실패');
				}
			}

			rrmdir($dir);
			respond(200, ['fileKey' => $fileKey]);

		default:
			fail(400, '알 수 없는 action 입니다.');
	}
} catch (Throwable $e) {
	fail(500, $e->getMessage());
}
