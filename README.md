# nAnOresolve

Editor de video de escritorio, sencillo y rápido de aprender, inspirado en el flujo de trabajo de
DaVinci Resolve y Filmora. **Versión Beta 1.1.**

Abre prácticamente cualquier formato de video, audio o imagen (lo que FFmpeg sepa leer) y exporta
siempre a partir de los archivos originales, a máxima calidad.

## Qué puedes hacer

| | Función | Cómo |
|---|---|---|
| ✂️ | **Cortes** | Área de trabajo *Cortes*: arrastra videos a la línea temporal, usa la cuchilla (`B`) o corta en el cursor (`Ctrl+B`). En la pista principal (V1), al borrar o recortar, lo que sigue se recorre solo ("cerrar huecos"). |
| 🎤 | **Voz desde el micrófono** | Botón **Voz** → aparece un botón grande en pantalla → al pulsarlo se graba desde donde esté el cursor, mientras ves el video. El audio queda como clip en una pista de audio. |
| ✨ | **Efectos y transiciones** | Pestañas *Transiciones* y *Efectos*: arrástralos sobre un clip. Transiciones de video (disolución, fundidos, barridos, empujes, zoom, iris, desenfoque) y de audio (fundido cruzado), más efectos de imagen y de voz. |
| 🔍 | **Zoom al estilo Filmora** | Botón **Zoom**: marca el inicio y el final, elige cuánto acercar y arrastra el punto de enfoque en el visor. El editor anima el acercamiento. |
| 🔤 | **Textos** | Botón **Texto** o pestaña *Texto* (título, subtítulo, tercio inferior, neón…). Fuente, color, borde, sombra y fondo en el inspector; muévelo arrastrándolo en el visor. |
| 🧲 | **Imán** | Botón del imán (`N`): la cuchilla se pega al cursor y a los cortes cercanos; los clips se pegan entre sí al moverlos o recortarlos. |
| ◆ | **Keyframes** | En el inspector, pulsa ◆ junto a posición, escala, rotación, opacidad, volumen o cantidad de un efecto. Los rombos aparecen sobre el clip y se pueden arrastrar. |
| 🎨 | **Color y plantillas** | Área de trabajo *Color*: plantillas con vista previa en vivo (blanco y negro, amarillo desierto al estilo *Breaking Bad*, teal & orange, vintage…) e intensidad y ajuste fino. |
| ▦ | **Censura** | Botón **Censurar**: dibuja un recuadro sobre la placa, el rostro o el documento. Pixelado por defecto o difuminado. **Seguir objeto** mueve la zona automáticamente para que acompañe a lo que tapa; si algo lo tapa un momento, sigue por inercia y lo vuelve a encontrar. |
| ⏩ | **Velocidad** | Botón **Velocidad**: cámara lenta o rápida de 0,1× a 10× con el control, los botones (0,25× … 4×) o escribiendo la duración que quieres. Puedes mantener el tono de las voces o dejar que cambie. El clip se acorta o se alarga solo y lo que sigue se recorre. |
| 🎞️ | **Configuración del video** | Botón con la resolución en la barra superior, `Ctrl+K` o *Archivo → Configuración del video*: horizontal, vertical (TikTok, Reels), cuadrado, 4:5 o tamaño personalizado, de 480p a 4K, y fotogramas por segundo (23,976 a 60 o cualquier valor de 1 a 120). Los clips se adaptan solos y, al cambiar de forma, los videos pueden ampliarse para llenar el cuadro. |
| ⬚ | **Recorte de imagen** | Botón **Recorte**: arrastra los bordes en el visor o elige una proporción (16:9, 9:16, 1:1…). «Rellenar el cuadro» amplía lo que queda, por ejemplo para pasar un video horizontal a vertical. Cada borde se puede animar con keyframes. |

Además: deshacer/rehacer, varias pistas de video y audio, imágenes y logos, separar audio,
autoguardado con recuperación, y exportación a MP4 (H.264 / H.265), MOV ProRes, MKV, WebM, AVI,
MP3 y WAV. Al exportar puedes elegir que el video lo codifique la tarjeta gráfica (NVIDIA, Intel o
AMD) si el equipo tiene una compatible.

## Instalación

Necesitas [Node.js](https://nodejs.org) 22 o superior. FFmpeg viene incluido como dependencia: no
hay que instalarlo aparte.

```bash
npm install
```

```bash
npm start
```

En Windows también puedes hacer doble clic en `iniciar.bat` (instala lo necesario la primera vez).

Para generar una carpeta con la aplicación lista para copiar a otro equipo (`dist/`):

```bash
npm run package
```

## Atajos de teclado

| Tecla | Acción |
|---|---|
| `Espacio` | Reproducir / pausar |
| `←` `→` | Fotograma anterior / siguiente (con `Mayús`, un segundo) |
| `↑` `↓` | Corte anterior / siguiente |
| `A` / `B` | Selección / cuchilla |
| `Ctrl+B` | Cortar en el cursor |
| `N` | Imán |
| `Supr` | Eliminar (con `Mayús` invierte el modo "cerrar huecos") |
| `Ctrl+C` `Ctrl+V` `Ctrl+D` | Copiar, pegar en el cursor, duplicar |
| `Ctrl+Z` `Ctrl+Y` | Deshacer / rehacer |
| `+` `−` `Mayús+Z` | Zoom de la línea temporal / verla entera |
| `Ctrl+S` `Ctrl+I` `Ctrl+E` | Guardar, importar, exportar |
| `Ctrl+K` | Configuración del video (resolución y fps) |

## Cómo funciona por dentro

- **Electron** para la ventana y **FFmpeg** (incluido) para leer y escribir cualquier formato.
- **Lo que ves es lo que se exporta.** La vista previa y la exportación usan el mismo compositor
  WebGL (`src/renderer/js/render`): color, zoom, censura, texto y transiciones se dibujan con los
  mismos shaders. Al exportar, FFmpeg decodifica los originales a fotogramas sin comprimir, el
  compositor los procesa y FFmpeg codifica el resultado.
- **Exportación rápida.** Los fotogramas viajan entre FFmpeg y el compositor en YUV 4:2:0 y la
  conversión de color la hace la tarjeta gráfica. En el equipo de pruebas, 1080p se exporta a unos
  40 fotogramas por segundo y 4K a unos 28.
- **Proxys automáticos.** Si un archivo no puede reproducirse directamente (HEVC con AC-3, ProRes,
  AVI, WMV…), se crea una copia ligera solo para la vista previa. Si la imagen sí se reproduce y
  solo falla el audio (por ejemplo, sonido 5.1), la copia convierte únicamente el audio y está
  lista en segundos. La exportación siempre lee el original.
- **Audio.** La mezcla usa las mismas cadenas en la vista previa y en la exportación (Web Audio).
  El sonido envolvente se pasa a estéreo igual en ambos casos.
- **HDR.** El video HDR se convierte a color estándar; con clic derecho sobre el archivo →
  *Ajustes de HDR* se elige la curva y el brillo, y la exportación usa los mismos ajustes.

```
src/main        proceso principal: ventana, diálogos, FFmpeg (análisis, proxys, exportación)
src/preload     puente entre la interfaz y el sistema
src/renderer    interfaz: línea temporal, visor, inspector, compositor, grabación, seguimiento
scripts         pruebas de humo que manejan la app real (npm run test:smoke)
```

## Limitaciones conocidas

- La velocidad es constante en cada clip: no hay rampas de velocidad ni reproducción hacia atrás.
- El seguimiento automático de la censura funciona mejor con objetos con detalle (bordes, letras).
  Si el objeto queda tapado más de un segundo, el seguimiento se detiene ahí y avisa: recoloca la
  zona donde reaparezca y vuelve a pulsar *Seguir objeto*.
- La codificación por tarjeta gráfica solo se ha probado con AMD; con NVIDIA, Intel y Apple se
  comprueba al exportar que funciona y, si no, se usa el procesador.
- La exportación en ProRes no usa la ruta rápida (conserva más detalle de color) y es más lenta.
- Probado en Windows 11. En macOS y Linux debería funcionar, pero no se ha comprobado.

## Licencia

MIT. FFmpeg se distribuye bajo sus propias licencias (LGPL/GPL).
