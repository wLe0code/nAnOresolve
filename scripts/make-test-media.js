'use strict';
// Genera material de prueba en varios formatos con el FFmpeg incluido.
//   node scripts/make-test-media.js [carpeta de salida]

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');

const out = path.resolve(process.argv[2] || path.join(__dirname, '.tmp', 'media'));
fs.mkdirSync(out, { recursive: true });

function make(name, args) {
  const file = path.join(out, name);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return;
  const r = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args, file], { stdio: 'inherit' });
  console.log(r.status === 0 ? 'ok   ' : 'FALLO', name);
}

const lavfi = (spec) => ['-f', 'lavfi', '-i', spec];
const tone = (freq, dur) => lavfi(`sine=frequency=${freq}:duration=${dur}`);

make('a_h264.mp4', [...lavfi('testsrc2=size=1280x720:rate=30:duration=8'), ...tone(440, 8), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-c:a', 'aac', '-shortest']);
make('b_hevc_ac3.mkv', [...lavfi('testsrc=size=1920x1080:rate=25:duration=6'), ...tone(660, 6), '-c:v', 'libx265', '-x265-params', 'log-level=error', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-c:a', 'ac3', '-shortest']);
make('c_mpeg4.avi', [...lavfi('smptebars=size=640x480:rate=30:duration=5'), ...tone(330, 5), '-c:v', 'mpeg4', '-q:v', '4', '-c:a', 'libmp3lame', '-shortest']);
make('d_vp9.webm', [...lavfi('testsrc2=size=854x480:rate=24:duration=5'), ...tone(550, 5), '-c:v', 'libvpx-vp9', '-b:v', '1M', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest']);
make('e_prores.mov', [...lavfi('testsrc2=size=1280x720:rate=30:duration=3'), ...tone(880, 3), '-c:v', 'prores_ks', '-profile:v', '2', '-c:a', 'pcm_s16le', '-shortest']);
make('f_wmv.wmv', [...lavfi('testsrc=size=640x360:rate=30:duration=4'), ...tone(500, 4), '-c:v', 'wmv2', '-b:v', '2M', '-c:a', 'wmav2', '-shortest']);
make('g_vertical.mp4', [...lavfi('testsrc2=size=720x1280:rate=30:duration=4'), ...tone(700, 4), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-c:a', 'aac', '-shortest']);
// "Placa" que se mueve sobre un fondo con ruido: sirve para probar la censura con seguimiento.
make('plate.mp4', [
  ...lavfi('color=c=0x30506a:size=1280x720:rate=30:duration=6,noise=alls=14:allf=t'),
  ...lavfi('color=c=white:size=180x56:rate=30:duration=6,drawgrid=w=30:h=28:t=3:c=black,drawbox=x=3:y=3:w=174:h=50:c=black:t=4'),
  '-filter_complex', "[0][1]overlay=x='150+120*t':y='320+60*sin(1.5*t)'",
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast',
]);
make('music.mp3', [...tone(220, 12), '-c:a', 'libmp3lame', '-b:a', '192k']);
make('logo.png', [...lavfi('color=c=black@0.0:size=400x200,format=rgba,drawbox=x=20:y=20:w=360:h=160:c=yellow@0.9:t=fill:replace=1,drawbox=x=140:y=50:w=120:h=100:c=red@1:t=fill:replace=1'), '-frames:v', '1']);

console.log(out);
