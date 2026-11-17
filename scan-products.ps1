# Escanea catálogo WooCommerce: detecta productos sin imagen y con descripción dañada/vacía
$envLines = Get-Content "D:\Proyectos Mecha Labs\MTX\.env"
$envVars = @{}
foreach ($line in $envLines) {
    if ($line -match "^([^=]+)=(.*)$") { $envVars[$matches[1]] = $matches[2] }
}
$baseUrl = $envVars["WC_URL"]
$ck = $envVars["WC_CONSUMER_KEY"]
$cs = $envVars["WC_CONSUMER_SECRET"]

$pair = "$ck`:$cs"
$bytes = [System.Text.Encoding]::ASCII.GetBytes($pair)
$b64 = [System.Convert]::ToBase64String($bytes)
$headers = @{ Authorization = "Basic $b64" }

function Strip-Html($html) {
    if ([string]::IsNullOrWhiteSpace($html)) { return "" }
    $text = $html -replace '<[^>]+>', ' '
    $text = [System.Net.WebUtility]::HtmlDecode($text)
    $text = $text -replace '\s+', ' '
    return $text.Trim()
}

$perPage = 100
$page = 1
$totalPages = 1
$allResults = @()
$placeholderPatterns = @('lorem ipsum', 'descripci', 'texto de prueba', 'sample product', 'test product', '\[vc_', '\[/vc_', 'shortcode')

do {
    $uri = "$baseUrl/wp-json/wc/v3/products?per_page=$perPage&page=$page&status=any"
    $resp = Invoke-WebRequest -Uri $uri -Headers $headers -Method Get -UseBasicParsing
    if ($page -eq 1) {
        $totalPages = [int]$resp.Headers['X-WP-TotalPages']
        Write-Output "Total paginas: $totalPages"
    }
    $products = $resp.Content | ConvertFrom-Json

    foreach ($p in $products) {
        $imgCount = $p.images.Count
        $descText = Strip-Html $p.description
        $shortDescText = Strip-Html $p.short_description
        $descLen = $descText.Length

        $issues = @()
        if ($imgCount -eq 0) { $issues += "SIN_IMAGEN" }
        if ($descLen -eq 0) { $issues += "DESC_VACIA" }
        elseif ($descLen -lt 50) { $issues += "DESC_MUY_CORTA" }

        $rawDesc = $p.description
        if ($rawDesc -match '\[vc_|\[/vc_|\[et_pb|\[fusion') { $issues += "SHORTCODE_SIN_RENDERIZAR" }
        if ($rawDesc -match 'lorem ipsum') { $issues += "TEXTO_PLACEHOLDER" }
        if ($rawDesc -match '&amp;amp;|Ã') { $issues += "ENCODING_ROTO" }
        $selfClosingOrVoid = '^(br|img|hr|input|meta|link|area|base|col|embed|source|track|wbr)$'
        $openTagMatches = [regex]::Matches($rawDesc, '<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*(?<!/)>')
        $openTags = ($openTagMatches | Where-Object { $_.Groups[1].Value -notmatch $selfClosingOrVoid }).Count
        $closeTags = ([regex]::Matches($rawDesc, '</[a-zA-Z][a-zA-Z0-9]*>')).Count
        if (($openTags - $closeTags) -gt 3) { $issues += "HTML_SIN_CERRAR" }

        $metaDesc = ($p.meta_data | Where-Object { $_.key -eq '_yoast_wpseo_metadesc' }).value
        $focusKw = ($p.meta_data | Where-Object { $_.key -eq '_yoast_wpseo_focuskw' }).value
        $linkdex = ($p.meta_data | Where-Object { $_.key -eq '_yoast_wpseo_linkdex' }).value
        $contentScore = ($p.meta_data | Where-Object { $_.key -eq '_yoast_wpseo_content_score' }).value

        if ([string]::IsNullOrWhiteSpace($metaDesc)) { $issues += "SIN_META_DESC" }
        if ([string]::IsNullOrWhiteSpace($focusKw)) { $issues += "SIN_FOCUS_KEYWORD" }
        if ($linkdex -ne $null -and $linkdex -ne "" -and [int]$linkdex -le 40) { $issues += "SEO_SCORE_BAJO($linkdex)" }

        if ($issues.Count -gt 0) {
            $allResults += [PSCustomObject]@{
                id = $p.id
                sku = $p.sku
                name = $p.name
                status = $p.status
                permalink = $p.permalink
                image_count = $imgCount
                desc_length = $descLen
                meta_desc_length = if ($metaDesc) { $metaDesc.Length } else { 0 }
                focus_keyword = $focusKw
                seo_score = $linkdex
                content_score = $contentScore
                issues = ($issues -join "|")
            }
        }
    }
    Write-Output "Procesada pagina $page de $totalPages ($($products.Count) productos)"
    $page++
} while ($page -le $totalPages)

$outDir = "C:\Users\CSARFL~1\AppData\Local\Temp\claude\D--Proyectos-Mecha-Labs-MTX\113b917f-69c4-4c35-828f-161588c626ed\scratchpad"
$allResults | Export-Csv -Path "$outDir\productos_con_problemas.csv" -NoTypeInformation -Encoding UTF8
Write-Output "TOTAL PRODUCTOS CON PROBLEMAS: $($allResults.Count)"
