# infinity-dropzone
파일 갯수, 용량 제한없는 js 업로더

* 한번에 2개의 파일을 처리합니다.
* 90MB 로 나누어 보낸 후 합칩니다.
* COMPRESSIBLE_EXTS 에 정의된 파일은 gzip 압축을 하여 전송량을 줄입니다.

사용법
```js
makeDropzone(selector, uploadUrl, {allowedExts, maxFileSize, maxFiles});
```
form submit
```php
function rrmdir($dir) {
	if (!is_dir($dir)) return;
	$items = scandir($dir);
	foreach ($items as $item) {
		if ($item === '.' || $item === '..') continue;
		$path = $dir . '/' . $item;
		is_dir($path) ? rrmdir($path) : unlink($path);
	}
	rmdir($dir);
}
$fileKeys = json_decode($_POST['fileKeys']);
if(count($fileKeys->files)) {
	if (!preg_match('/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i', $fileKeys->sessionId)) {
		fail(400, 'sessionId 형식이 올바르지 않습니다.');
	}
	foreach ($fileKeys->files as $fileKey) {
		if (!preg_match('/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.[\da-z]{1,20}$/i', $fileKey->key)) {
			fail(400, 'fileKey 형식이 올바르지 않습니다.');
		}
	}
	$prefix = $_SERVER['HOME'].'uploads';
	$date = date('Y/m');
	if(!is_dir($prefix.'/'.$date)) mkdir($prefix.'/'.$date, 0755, true);
	$stmt = $db->prepare('INSERT INTO uploads (sessionId, fileKey, fileName, filePath) VALUES (:sessionId, :fileKey, :fileName, :filePath)');
	foreach ($fileKeys->files as $fileKey) {
		$fields = [
			'sessionId' => $fileKeys->sessionId,
			'fileKey' => $fileKey->key,
			'fileName' => $fileKey->name,
			'filePath' => '/'.$date.'/'.$fileKey->key,
		];
		rename("/tmp/dropzone/final/{$fileKey->sessionId}/{$fileKey->key}", $prefix.'/'.$date.'/'.$fileKey->key);
		$stmt->execute($fields);
	}
	rrmdir("/tmp/dropzone/final/{$fileKeys->sessionId}");
	rrmdir("/tmp/dropzone/tmp/{$fileKeys->sessionId}");
}
```

예제
```html
<link rel="stylesheet" href="infinity-dropzone.css">

<form>
	<div class="dropzone">
		<div class="zonebox">
			파일을 여기로 드래그하거나 클릭해서 선택하세요
			<input type="file" multiple />
		</div>
		<input type="hidden" name="fileKeys">
		<div class="files"></div>
	</div>
</form>
<script src="infinity-dropzone.js"></script>
<script>
makeDropzone('.dropzone', 'upload.php', {
	allowedExts:['jpg', 'jpeg', 'png', 'gz', 'bz2', 'iso', 'txt', 'csv', 'svg'],
	// maxFileSize: 2 * 1024 * 1024 * 1024,
	// maxFiles: 100,
});
</script>
```

임시 파일들은 cron 으로 삭제하세요.
```crontab
0 0 * * * find /tmp/dropzone -mindepth 2 -maxdepth 2 -mtime +1 -exec rm -rf {} \;
```