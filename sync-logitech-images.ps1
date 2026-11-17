# Sincroniza imagenes de producto Logitech: busca en las carpetas TOOLKIT-* (brandkit)
# candidatos de foto para productos que en WooCommerce tienen pocas/ninguna imagen.
#
# Uso:
#   .\sync-logitech-images.ps1                      -> modo Scan (default): genera reporte + extrae candidatos
#   .\sync-logitech-images.ps1 -MinImages 3          -> cambia el umbral de "imagenes insuficientes"
#   .\sync-logitech-images.ps1 -Upload -ProductId 253705 -ImagePath "C:\...\imagen.png"
#                                                     -> sube esa imagen puntual como imagen del producto en WooCommerce
#
# El modo Scan NUNCA modifica el sitio en vivo. Solo el modo -Upload lo hace, y siempre
# apuntando a un producto e imagen especificos que ya revisaste a mano.

param(
    [switch]$Upload,
    [int]$ProductId,
    [string]$ImagePath,
    [int]$MinImages = 3,
    [int]$LogitechCategoryId = 146
)

$ErrorActionPreference = "Stop"
$root = "D:\Proyectos Mecha Labs\MTX"

$envLines = Get-Content "$root\.env"
$envVars = @{}
foreach ($line in $envLines) {
    if ($line -match "^([^=]+)=(.*)$") { $envVars[$matches[1]] = $matches[2] }
}
$baseUrl = $envVars["WC_URL"]
$ck = $envVars["WC_CONSUMER_KEY"]
$cs = $envVars["WC_CONSUMER_SECRET"]
$pair = "$ck`:$cs"
$b64 = [System.Convert]::ToBase64String([System.Text.Encoding]::ASCII.GetBytes($pair))
$headers = @{ Authorization = "Basic $b64" }

# ---------- modo Upload: sube UNA imagen a UN producto puntual, no toca nada mas ----------
if ($Upload) {
    if (-not $ProductId -or -not $ImagePath -or -not (Test-Path $ImagePath)) {
        Write-Error "Uso: -Upload -ProductId <id> -ImagePath <ruta a archivo existente>"
        exit 1
    }
    $bytes = [System.IO.File]::ReadAllBytes($ImagePath)
    $b64img = [System.Convert]::ToBase64String($bytes)
    $filename = Split-Path $ImagePath -Leaf
    $mediaBody = @{ title = $filename; file_data = $b64img } | ConvertTo-Json
    # WooCommerce no acepta subida binaria directa; se sube a la Media Library de WP primero.
    Write-Output "Subiendo '$filename' a la Media Library de WP..."
    $mediaResp = Invoke-RestMethod -Uri "$baseUrl/wp-json/wp/v2/media" -Method Post -Headers $headers `
        -InFile $ImagePath -ContentType "image/$(([IO.Path]::GetExtension($ImagePath)).TrimStart('.').Replace('jpg','jpeg'))" `
        -Headers (@{ Authorization = "Basic $b64"; "Content-Disposition" = "attachment; filename=$filename" })
    $mediaUrl = $mediaResp.source_url
    Write-Output "Imagen subida: $mediaUrl (media id $($mediaResp.id))"

    $prodUri = "$baseUrl/wp-json/wc/v3/products/$ProductId"
    $current = Invoke-RestMethod -Uri $prodUri -Headers $headers -Method Get
    $newImages = @(@{ src = $mediaUrl }) + ($current.images | ForEach-Object { @{ id = $_.id } })
    $body = @{ images = $newImages } | ConvertTo-Json -Depth 5
    Invoke-RestMethod -Uri $prodUri -Headers $headers -Method Put -Body $body -ContentType "application/json" | Out-Null
    Write-Output "Producto $ProductId actualizado. Ahora tiene $(($newImages).Count) imagen(es). El microsite Logitech la reflejara automaticamente (lee /wc/store/v1/products en vivo)."
    exit 0
}

# ---------- modo Scan (default) ----------
$toolkitRoots = Get-ChildItem -Path $root -Directory | Where-Object { $_.Name -match "^TOOLKIT-" } | ForEach-Object {
    Join-Path $_.FullName "TOOLKIT"
} | Where-Object { Test-Path $_ }

Write-Output "Carpetas brandkit detectadas:"
$toolkitRoots | ForEach-Object { Write-Output "  $_" }
Write-Output ""

# Trae todos los productos Logitech (categoria 146), cualquier estado (publish/draft/pending)
$perPage = 100
$page = 1
$all = @()
do {
    $uri = "$baseUrl/wp-json/wc/v3/products?category=$LogitechCategoryId&per_page=$perPage&page=$page&status=any"
    $resp = Invoke-WebRequest -Uri $uri -Headers $headers -Method Get -UseBasicParsing
    $totalPages = [int]$resp.Headers['X-WP-TotalPages']
    $all += ($resp.Content | ConvertFrom-Json)
    $page++
} while ($page -le $totalPages)

$flagged = $all | Where-Object { $_.images.Count -lt $MinImages -or $_.status -eq 'draft' }
Write-Output "Productos Logitech totales: $($all.Count) | con pocas imagenes (<$MinImages) o en borrador: $($flagged.Count)"
Write-Output ""

if (-not $flagged.Count) { Write-Output "Nada que revisar."; exit 0 }

$reviewRoot = Join-Path $root "brandkit-candidatos"
New-Item -ItemType Directory -Force -Path $reviewRoot | Out-Null

foreach ($p in $flagged) {
    $name = $p.name -replace '&amp;', '&'
    Write-Output "=== [$($p.id)] $name (imgs: $($p.images.Count), status: $($p.status)) ==="

    # extrae un termino de busqueda: codigo de modelo (M170, G923, K950...) o una palabra clave sustancial del nombre.
    # Requiere letras+digitos juntos (evita capturar palabras sueltas de 1-2 letras como "G" que hacen match con todo).
    $modelMatch = [regex]::Match($name, '\b[A-Za-z]{1,4}\d{2,4}[A-Za-z]?\b|\b[A-Za-z]{1,4}\s\d{2,4}[A-Za-z]?\b')
    $stopWords = @('logitech','mouse','teclado','auricular','auriculares','inalambrico','inalámbrico',
        'gaming','bluetooth','usb','the','para','con','sin','plug','play','de','el','la','los','las')
    if ($modelMatch.Success) {
        $keyword = $modelMatch.Value -replace '\s',''
    } else {
        $keyword = ($name -split '\s+') | Where-Object { $_.Length -ge 4 -and ($stopWords -notcontains $_.ToLower()) } | Select-Object -First 1
    }

    if (-not $keyword -or $keyword.Length -lt 3) {
        Write-Output "  Sin termino de busqueda util en el nombre. Revisar manualmente."
        Write-Output ""
        continue
    }

    $matches = @()
    foreach ($tk in $toolkitRoots) {
        $matches += Get-ChildItem -Path $tk -Recurse -File -Include *.pptx, *.zip -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match [regex]::Escape($keyword) -or $_.Directory.Name -match [regex]::Escape($keyword) }
    }
    $matches = $matches | Select-Object -Unique

    if (-not $matches.Count) {
        Write-Output "  Sin coincidencia en el brandkit para el termino '$keyword'. Revisar manualmente."
        Write-Output ""
        continue
    }

    $productDir = Join-Path $reviewRoot "$($p.id)_$($keyword -replace '[^\w]','')"
    New-Item -ItemType Directory -Force -Path $productDir | Out-Null

    foreach ($m in $matches) {
        Write-Output "  Coincidencia: $($m.FullName)"
        if ($m.Extension -eq '.pptx') {
            $tmpZip = Join-Path $env:TEMP "$([guid]::NewGuid()).zip"
            Copy-Item $m.FullName $tmpZip
            $extractDir = Join-Path $env:TEMP ([guid]::NewGuid())
            Expand-Archive -Path $tmpZip -DestinationPath $extractDir -Force
            $mediaDir = Join-Path $extractDir "ppt\media"
            if (Test-Path $mediaDir) {
                Get-ChildItem $mediaDir -File | Where-Object { $_.Extension -match '\.(jpg|jpeg|png)$' } |
                    Where-Object { $_.Length -gt 80KB } |
                    Sort-Object Length -Descending |
                    Select-Object -First 6 |
                    ForEach-Object {
                        $dest = Join-Path $productDir "$($m.BaseName)_$($_.Name)"
                        Copy-Item $_.FullName $dest -Force
                    }
            }
            Remove-Item $tmpZip, $extractDir -Recurse -Force -ErrorAction SilentlyContinue
        } elseif ($m.Extension -eq '.zip') {
            $extractDir = Join-Path $env:TEMP ([guid]::NewGuid())
            Expand-Archive -Path $m.FullName -DestinationPath $extractDir -Force
            Get-ChildItem $extractDir -Recurse -Include *.jpg, *.jpeg, *.png, *.webp -File |
                Where-Object { $_.Length -gt 80KB } |
                Sort-Object Length -Descending |
                Select-Object -First 6 |
                ForEach-Object {
                    $dest = Join-Path $productDir "$($m.BaseName)_$($_.Name)"
                    Copy-Item $_.FullName $dest -Force
                }
            Remove-Item $extractDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    Write-Output "  Candidatos extraidos en: $productDir"
    Write-Output "  IMPORTANTE: revisa a mano que el modelo/color coincida exactamente antes de subir (el brandkit mezcla variantes, ej. M170 vs M171)."
    Write-Output ""
}

Write-Output "Listo. Revisa las imagenes en '$reviewRoot' y luego corre:"
Write-Output "  .\sync-logitech-images.ps1 -Upload -ProductId <id> -ImagePath <ruta de la imagen elegida>"
