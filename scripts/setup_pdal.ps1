<#
arrow プラグインが動作する PDAL を用意する。

OSGeo4W 版 (pdal 2.10.0-4) は libpdal_plugin_writer_arrow.dll を同梱していて
--drivers にも writers.arrow が出るが、parquet 書き出しで必ずクラッシュする
(exit 0xC0000409 = STACK_BUFFER_OVERRUN、出力は PAR1 の 4 バイトのみ)。
feather は正常に書ける。batch_size や write_pipeline_metadata を変えても再現。
そのため conda-forge 版を隔離環境に入れて使う。

インストール先は C:\mm\pdal (パスは短くすること。
Windows の 260 文字制限に掛かると micromamba のパッケージ展開が失敗する)。
#>

$ErrorActionPreference = "Stop"

$root = "C:\mm"
$env:MAMBA_ROOT_PREFIX = $root
$mm = "$root\micromamba.exe"

New-Item -ItemType Directory -Force $root | Out-Null

if (-not (Test-Path $mm)) {
    Invoke-WebRequest `
        -Uri "https://github.com/mamba-org/micromamba-releases/releases/latest/download/micromamba-win-64.exe" `
        -OutFile $mm
}

& $mm create -y -p "$root\pdal" -c conda-forge pdal untwine   # untwine は COPC 生成用 (writers.copc より 13 倍速い。REPORT.md 7 章)

& "$root\pdal\Library\bin\pdal.exe" --version
& "$root\pdal\Library\bin\pdal.exe" --drivers | Select-String arrow
& "$root\pdal\Library\bin\untwine.exe" --help 2>&1 | Select-Object -First 1
