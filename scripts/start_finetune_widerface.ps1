param(
    [string]$CondaEnv = "sanitize-ai",
    [int]$Epochs = 50,
    [int]$ImgSize = 640,
    [int]$Batch = 16,
    [string]$RunName = "widerface-ft"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$condaExe = "C:/Users/Administrator/miniconda3/Scripts/conda.exe"
if (-not (Test-Path $condaExe)) {
    throw "Conda executable not found at $condaExe"
}

$datasetRoot = Join-Path $repoRoot "datasets/widerface"
$rawRoot = Join-Path $datasetRoot "raw"
$yoloRoot = Join-Path $datasetRoot "yolo"
New-Item -ItemType Directory -Path $rawRoot -Force | Out-Null
New-Item -ItemType Directory -Path $yoloRoot -Force | Out-Null

$downloads = @(
    @("https://huggingface.co/datasets/wider_face/resolve/main/data/WIDER_train.zip", (Join-Path $rawRoot "WIDER_train.zip")),
    @("https://huggingface.co/datasets/wider_face/resolve/main/data/WIDER_val.zip", (Join-Path $rawRoot "WIDER_val.zip")),
    @("http://shuoyang1213.me/WIDERFACE/support/bbx_annotation/wider_face_split.zip", (Join-Path $rawRoot "wider_face_split.zip"))
)

foreach ($item in $downloads) {
    $url = $item[0]
    $dst = $item[1]
    if (-not (Test-Path $dst)) {
        Write-Host "Downloading $url ..."
        Invoke-WebRequest -Uri $url -OutFile $dst -TimeoutSec 0
    } else {
        Write-Host "Already downloaded: $dst"
    }
}

$extracts = @(
    @((Join-Path $rawRoot "WIDER_train.zip"), (Join-Path $rawRoot "WIDER_train")),
    @((Join-Path $rawRoot "WIDER_val.zip"), (Join-Path $rawRoot "WIDER_val")),
    @((Join-Path $rawRoot "wider_face_split.zip"), (Join-Path $rawRoot "wider_face_split"))
)

foreach ($item in $extracts) {
    $zip = $item[0]
    $target = $item[1]
    if (-not (Test-Path $target)) {
        Write-Host "Extracting $zip ..."
        Expand-Archive -Path $zip -DestinationPath $rawRoot -Force
    } else {
        Write-Host "Already extracted: $target"
    }
}

Write-Host "Converting WIDER FACE to YOLO format ..."
& $condaExe run -n $CondaEnv python -m sanitizer.training.prepare_widerface --raw $rawRoot --out $yoloRoot
if ($LASTEXITCODE -ne 0) {
    throw "Dataset conversion failed."
}

$weights = Join-Path $repoRoot "models/yolov8n-face.pt"
if (-not (Test-Path $weights)) {
    $weights = Join-Path $repoRoot "yolov8n.pt"
}

Write-Host "Starting fine-tuning with weights: $weights"
& $condaExe run -n $CondaEnv python -m sanitizer.training.train_yolo_face --data (Join-Path $yoloRoot "data.yaml") --weights $weights --epochs $Epochs --imgsz $ImgSize --batch $Batch --project "runs/face" --name $RunName
if ($LASTEXITCODE -ne 0) {
    throw "Training failed."
}

Write-Host "Fine-tuning completed. Best checkpoint should be under runs/face/$RunName/weights/best.pt"
