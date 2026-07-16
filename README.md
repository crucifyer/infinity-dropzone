# infinity-dropzone
파일 갯수, 용량 제한없는 js 업로더

* 한번에 2개의 파일을 처리합니다.
* 90MB 로 나누어 보낸 후 합칩니다.
* COMPRESSIBLE_EXTS 에 정의된 파일은 gzip 압축을 하여 전송량을 줄입니다.

사용법
```js
makeDropzone(selector, uploadUrl, {allowedExts, maxFileSize, maxFiles, i18nMessages});
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
			<span class="dz-label"></span>
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
	// i18nMessages: {},
});
</script>
```

임시 파일들은 cron 으로 삭제하세요.
```crontab
0 0 * * * find /tmp/dropzone -mindepth 2 -maxdepth 2 -mtime +1 -exec rm -rf {} \;
```

i18n
ko, en 내장되어 있고, 그 외의 언어는 수동 추가 가능합니다.
```js
// ja
{
	'placeholder': 'ファイルをここにドラッグするか、クリックして選択してください',
	'UploadCancelledError': 'アップロードがキャンセルされました',
	'UploadFailedError': 'アップロードに失敗しました',
	'UploadRejectedError': 'アップロードが拒否されました',
	'ServerResponseParseError': 'サーバー応答の解析に失敗しました',
	'NetworkError': 'ネットワークエラー',
	'progress': '進捗率',
	'pending': '保留中',
	'done': '完了',
	'error': '失敗',
	'blocked': '拒否',
	'duplicate-file': 'すでにリストにあるファイルです',
	'extension-not-allowed': '許可されていない拡張子です',
	'file-too-large': '許可された最大容量を超えました',
	'max-files-reached': 'これ以上追加できません（最大数を超えました）',
}

// fr
{
	'placeholder': 'Faites glisser le fichier ici ou cliquez dessus pour le sélectionner',
	'UploadCancelledError': 'Le téléchargement a été annulé',
	'UploadFailedError': 'Échec du téléchargement',
	'UploadRejectedError': 'Le téléchargement a été refusé',
	'ServerResponseParseError': 'Échec de l\'analyse de la réponse du serveur',
	'NetworkError': 'Erreur réseau',
	'progress': 'Taux d\'avancement',
	'pending': 'En attente',
	'done': 'Terminé',
	'error': 'Échec',
	'blocked': 'Refusé',
	'duplicate-file': 'Ce fichier figure déjà dans la liste',
	'extension-not-allowed': 'Extension non autorisée',
	'file-too-large': 'La taille maximale autorisée a été dépassée',
	'max-files-reached': 'Impossible d\'ajouter d\'autres fichiers (nombre maximal atteint)',
}

// zh-CN
{
	'placeholder': '请将文件拖放到此处，或点击选择文件',
	'UploadCancelledError': '上传已被取消',
	'UploadFailedError': '上传失败',
	'UploadRejectedError': '上传被拒绝',
	'ServerResponseParseError': '服务器响应解析失败',
	'NetworkError': '网络错误',
	'progress': '进度',
	'pending': '待处理',
	'done': '已完成',
	'error': '失败',
	'blocked': '被拒绝',
	'duplicate-file': '该文件已存在于列表中',
	'extension-not-allowed': '不允许的文件扩展名',
	'file-too-large': '超过了允许的最大容量',
	'max-files-reached': '无法再添加（已超过最大数量）',
}

// zh-*
{
	'placeholder': '請將檔案拖曳至此處，或點擊選取',
	'UploadCancelledError': '上傳已取消',
	'UploadFailedError': '上傳失敗',
	'UploadRejectedError': '上傳遭拒絕',
	'ServerResponseParseError': '伺服器回應解析失敗',
	'NetworkError': '網路錯誤',
	'progress': '進度',
	'pending': '待處理',
	'done': '已完成',
	'error': '失敗',
	'blocked': '遭拒絕',
	'duplicate-file': '此檔案已存在於清單中',
	'extension-not-allowed': '不允許的檔案副檔名',
	'file-too-large': '超過允許的最大容量',
	'max-files-reached': '無法再新增檔案（已超過最大數量）',
}

// vi
{
	'placeholder': 'Hãy kéo tệp vào đây hoặc nhấp chuột để chọn',
	'UploadCancelledError': 'Quá trình tải lên đã bị hủy',
	'UploadFailedError': 'Tải lên không thành công',
	'UploadRejectedError': 'Quá trình tải lên đã bị từ chối',
	'ServerResponseParseError': 'Lỗi phân tích phản hồi từ máy chủ',
	'NetworkError': 'Lỗi mạng',
	'progress': 'Tỷ lệ hoàn thành',
	'pending': 'Đang chờ xử lý',
	'done': 'Đã hoàn thành',
	'error': 'Thất bại',
	'blocked': 'Bị từ chối',
	'duplicate-file': 'Tệp này đã có trong danh sách',
	'extension-not-allowed': 'Phần mở rộng không được phép',
	'file-too-large': 'Đã vượt quá dung lượng tối đa cho phép',
	'max-files-reached': 'Không thể thêm nữa (đã vượt quá số lượng tối đa)',
}

// es
{
	'placeholder': 'Arrastra el archivo hasta aquí o haz clic para seleccionarlo',
	'UploadCancelledError': 'La subida se ha cancelado',
	'UploadFailedError': 'Error en la subida',
	'UploadRejectedError': 'La subida ha sido rechazada',
	'ServerResponseParseError': 'Error al analizar la respuesta del servidor',
	'NetworkError': 'Error de red',
	'progress': 'Porcentaje de avance',
	'pending': 'En espera',
	'done': 'Completado',
	'error': 'Error',
	'blocked': 'Rechazado',
	'duplicate-file': 'Este archivo ya está en la lista',
	'extension-not-allowed': 'Extensión no permitida',
	'file-too-large': 'Se ha superado el tamaño máximo permitido',
	'max-files-reached': 'No se pueden añadir más (se ha superado el número máximo)',
}
```