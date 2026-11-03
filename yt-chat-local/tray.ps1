param([int]$Port = 8787)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$base = "http://127.0.0.1:$Port"

# Vẽ icon tròn có nút play, mỗi trạng thái một màu
$icons = @{}
function Get-StateIcon([string]$hex) {
  if ($icons.ContainsKey($hex)) { return $icons[$hex] }
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($hex))), 1, 1, 30, 30)
  $pts = [System.Drawing.Point[]]@((New-Object System.Drawing.Point 12, 9), (New-Object System.Drawing.Point 12, 23), (New-Object System.Drawing.Point 24, 16))
  $g.FillPolygon([System.Drawing.Brushes]::White, $pts)
  $g.Dispose()
  $icons[$hex] = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  return $icons[$hex]
}

$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = Get-StateIcon '#94a3b8'
$ni.Text = 'YT Chat: đang khởi động...'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miStatus = $menu.Items.Add('YT Chat: đang khởi động...'); $miStatus.Enabled = $false
$miQuota = $menu.Items.Add('Quota: --'); $miQuota.Enabled = $false
[void]$menu.Items.Add('-')
$miOpen = $menu.Items.Add('Mở giao diện chỉnh sửa')
$miStop = $menu.Items.Add('Dừng chương trình (Stop)')
$ni.ContextMenuStrip = $menu
$ni.Visible = $true

function Close-Tray { $timer.Stop(); $ni.Visible = $false; $ni.Dispose(); [System.Windows.Forms.Application]::Exit() }

$miOpen.add_Click({ Start-Process $base })
$ni.add_DoubleClick({ Start-Process $base })
$miStop.add_Click({
  try { Invoke-WebRequest -UseBasicParsing -Method Post -Headers @{ 'x-local' = '1' } -TimeoutSec 3 "$base/api/quit" | Out-Null } catch {}
  Close-Tray
})

$map = @{
  ok      = @('Đang chạy, nhận chat bình thường', '#22c55e')
  connect = @('Đang kết nối tới live chat...', '#f59e0b')
  wait    = @('Chưa thấy live chat, đang thử lại', '#f59e0b')
  quota   = @('Hết quota, đang tạm dừng', '#ef4444')
  err     = @('Có lỗi (xem app.log)', '#ef4444')
  ended   = @('Live chat đã kết thúc', '#94a3b8')
  idle    = @('Đang chạy, chưa nhập link video', '#94a3b8')
}
$fails = 0
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({
  try {
    $s = Invoke-RestMethod -TimeoutSec 2 "$base/api/status"
    $fails = 0
    $m = $map[[string]$s.state]; if (-not $m) { $m = @([string]$s.state, '#94a3b8') }
    $ni.Icon = Get-StateIcon $m[1]
    $txt = 'YT Chat: ' + $m[0]
    $miStatus.Text = $txt
    $miQuota.Text = "Quota ước tính: $($s.quota.used)/$($s.quota.limit)"
    $ni.Text = $txt.Substring(0, [Math]::Min(63, $txt.Length))
  } catch {
    $fails++
    if ($fails -ge 2) { Close-Tray }   # server đã tắt (vd. chạy stop.bat) -> tự dọn icon
  }
})
$timer.Start()
$ni.ShowBalloonTip(3000, 'YT Chat', "Đang chạy ở cổng $Port. Chuột phải vào icon để Stop.", [System.Windows.Forms.ToolTipIcon]::Info)
[System.Windows.Forms.Application]::Run()
