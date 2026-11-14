import type { Finding } from '../core/types.js';

// File uploads whose type check reads only what the sender chose to say about the file.
//
// The extension, the `accept` attribute and the declared MIME type (`file.type`, multer's
// `mimetype`, a `Content-Type` part header) are all written by whoever sends the request. A
// check built from them stops a user who picks the wrong file by accident and nobody else:
// `shell.php` renamed to `avatar.png` with `Content-Type: image/png` passes every one of them.
// The only thing the sender does not get to declare is the content, so the check that holds
// reads the first bytes of the file — its magic bytes — on the server.
//
// Heuristic over source text, like the other backend checks, and deliberately narrow: it
// fires only on a file that both receives an upload AND compares its name or declared type
// against something, AND never reads the content. An upload with no type check at all is not
// flagged — plenty of them (attachments, backups) legitimately accept anything, and saying
// "validates by name" about code that validates nothing would be a false statement.

/** A file that receives, parses or stores an uploaded file. */
const UPLOAD_HANDLER = new RegExp(
  [
    // Node
    '\\bmulter\\b',
    '\\bformidable\\b',
    '\\bbusboy\\b',
    'express-fileupload',
    '@fastify/multipart',
    '\\breq(uest)?\\.files?\\b',
    '\\.formData\\(\\)',
    '\\bFileInterceptor\\b',
    '@UploadedFiles?\\b',
    // Browser-direct uploads to a storage bucket: the only check is the one in this file.
    '\\.storage\\s*\\.from\\([^)]*\\)\\s*\\.upload\\(',
    '\\buploadBytes(Resumable)?\\(',
    '\\bPutObjectCommand\\b',
    // Python
    '\\brequest\\.(files|FILES)\\b',
    '\\bUploadFile\\b',
    // PHP
    '\\$_FILES\\b',
    '\\bmove_uploaded_file\\(',
    // Go
    '\\.FormFile\\(',
    '\\.ParseMultipartForm\\(',
    // Java / Spring
    '\\bMultipartFile\\b',
  ].join('|'),
);

/**
 * Where the name or the declared type is read. On its own this proves nothing — the
 * extension is routinely read to NAME the stored file — so it only counts as a check on a
 * line that also compares it (see COMPARE).
 */
const NAME_SOURCE = new RegExp(
  [
    '\\bextname\\s*\\(',
    '\\.split\\(\\s*[\'"`]\\.[\'"`]\\s*\\)\\s*\\.pop\\(',
    '\\.lastIndexOf\\(\\s*[\'"`]\\.[\'"`]',
    '\\bsplitext\\s*\\(',
    'PATHINFO_EXTENSION',
    '\\bfilepath\\.Ext\\(',
    '\\bgetExtension\\(',
    '\\.originalname\\b',
    '\\.getOriginalFilename\\(',
    '\\.mime_?type\\b',
    '\\.content_type\\b',
    '\\.getContentType\\(',
    '\\bHeader\\.Get\\(\\s*"Content-Type"',
    '\\$_FILES\\[[^\\]]+\\]\\s*\\[\\s*[\'"]type[\'"]\\s*\\]',
    // `file.type`, `imageFile.type`, `files[0].type` — but not `action.type`, `event.type`, or
    // the `profile.type` a login form handler compares all day.
    '\\b\\w*((?<!pro)file|upload|image|img|attachment|blob|avatar|photo|picture|document|media)s?(\\[\\d+\\])?\\.type\\b',
  ].join('|'),
  'i',
);

/** A comparison, allowlist lookup or pattern test on the same line as a NAME_SOURCE. */
const COMPARE =
  /[!=]==?|\.(includes|startsWith|endsWith|test|match|has|indexOf|contains)\(|\bnot\s+in\b|\bin\s+[\w[({]|\bin_array\(|\bswitch\s*\(|\bcase\s/;

/**
 * Checks that are a type restriction by construction, with no comparison needed on the line:
 * an extension regex, an `accept` attribute, a bucket-level MIME allowlist (which Supabase
 * and Firebase enforce against the declared `Content-Type`, not the bytes).
 */
const NAME_CHECK_ALONE = new RegExp(
  [
    '\\\\\\.\\(\\??:?(jpe?g|png|gif|webp|pdf|svg|docx?|xlsx?|csv|mp[34]|heic|zip)\\b',
    '\\baccept\\s*=\\s*[\'"{]',
    '\\ballowedMimeTypes\\s*:',
    // The extension read on one line and compared on another: `ext !== '.png'`,
    // `ALLOWED.includes(ext)`, Flask's `ALLOWED_EXTENSIONS`.
    '\\b(file_?)?ext(ension)?\\s*(!==?|===?|\\bnot\\s+in\\b|\\bin\\s+[\\w[({])',
    '\\.(includes|has|indexOf)\\(\\s*(file_?)?ext(ension)?\\s*\\)',
    '\\ballowed_?(file_?)?ext(ension)?s\\b',
    '\\ballowed_mime_types\\b',
  ].join('|'),
  'i',
);

/**
 * Anything that reads the content: a magic-byte library, a signature literal, or a decoder
 * that fails on bytes that are not what they claim to be. Generous on purpose — a decoder
 * like sharp or Pillow is a real content check, and missing one here turns a correct handler
 * into a false accusation.
 */
const CONTENT_CHECK = new RegExp(
  [
    // Node
    '\\bfileTypeFrom(Buffer|File|Stream|Blob|Tokenizer)\\b',
    '[\'"]file-type[\'"]',
    '\\bFileType\\.from',
    'magic-bytes',
    '\\bmmmagic\\b',
    '\\bdetect-file-type\\b',
    '[\'"]image-type[\'"]',
    '\\bsharp\\s*\\(',
    '\\bJimp\\.read\\b',
    // Python
    '\\bimport\\s+magic\\b',
    '\\bmagic\\.from_(buffer|file)\\b',
    '\\bfiletype\\.(guess|is_|image_match|match)',
    '\\bpuremagic\\b',
    '\\bimghdr\\b',
    '\\bImage\\.open\\(',
    // PHP
    '\\bfinfo_(file|buffer|open)\\(',
    '\\bnew\\s+finfo\\b',
    '\\bmime_content_type\\(',
    '\\bgetimagesize\\(',
    '\\bexif_imagetype\\(',
    '\\bimagecreatefrom\\w+\\(',
    // Go
    '\\bhttp\\.DetectContentType\\(',
    '\\bmimetype\\.Detect',
    '\\bfiletype\\.Match\\(',
    '\\bimage\\.Decode(Config)?\\(',
    // Java
    '\\bTika\\b',
    '\\bguessContentTypeFromStream\\(',
    // NestJS ≥ 10.4.16 / 11 checks magic numbers in FileTypeValidator.
    '\\bFileTypeValidator\\b',
    // Hand-rolled: named for what they are, or the signatures themselves.
    'magic[\\s_-]*(bytes?|numbers?)',
    'file[\\s_-]*signature',
    '\\\\x89PNG|%PDF-|\\bffd8ff\\b|\\b89504e47\\b|\\b25504446\\b|\\b504b0304\\b',
    // PNG, JPEG, PDF and ZIP signatures as byte literals, in a list or compared one by one.
    '\\b0x89\\b[^\\n]{0,40}\\b0x50\\b|\\b0xff\\b[^\\n]{0,40}\\b0xd8\\b|\\b0x25\\b[^\\n]{0,40}\\b0x50\\b|\\b0x50\\b[^\\n]{0,40}\\b0x4b\\b',
    '\\b137\\s*,\\s*80\\s*,\\s*78\\s*,\\s*71\\b|\\b255\\s*,\\s*216\\s*,\\s*255\\b',
  ].join('|'),
  'i',
);

/** The first line that restricts the upload by name or declared type, 1-based. */
function nameCheckLine(content: string): { line: number; text: string } | null {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    if (NAME_CHECK_ALONE.test(text) || (NAME_SOURCE.test(text) && COMPARE.test(text))) {
      return { line: i + 1, text: text.trim() };
    }
  }
  return null;
}

/** An upload whose type check trusts the extension, the `accept` attribute or the declared MIME. */
export function checkUploadValidation(path: string, content: string): Finding | null {
  if (!UPLOAD_HANDLER.test(content)) return null;
  if (CONTENT_CHECK.test(content)) return null;
  const hit = nameCheckLine(content);
  if (!hit) return null;

  const quote = hit.text.length > 120 ? `${hit.text.slice(0, 117)}…` : hit.text;
  return {
    id: `upload_type_by_name_${path.replace(/[^A-Za-z0-9]/g, '_')}`,
    es: {
      label:
        'La subida de archivos se valida por el nombre o el tipo declarado, no por el contenido',
      evidence: `El tipo se comprueba con \`${quote}\`, y nada en el fichero lee el contenido (magic bytes, file-type, finfo…).`,
      exploit:
        'La extensión, el atributo `accept` y el tipo MIME los escribe quien envía la petición. Un `shell.php` o un `.html` con JavaScript, renombrado a `foto.png` y enviado con `Content-Type: image/png` por curl, pasa todas esas comprobaciones — el `accept` ni siquiera se ejecuta, porque vive en el navegador.',
      impact:
        'Según dónde se guarde y cómo se sirva, eso es XSS almacenado desde tu propio dominio (un SVG o HTML servido como tal), ejecución de código si la carpeta interpreta scripts, o malware alojado a tu nombre.',
      why: 'Comprueba el tipo por lo único que el remitente no elige: los primeros bytes del fichero. Léelos en el servidor — en la ruta, o en una Edge Function o trigger del bucket si el navegador sube directo al storage — y compáralos con una lista de tipos permitidos (`file-type` en Node, `python-magic` o `filetype` en Python, `finfo` en PHP, `http.DetectContentType` en Go). Guarda con un nombre generado y una extensión derivada de ese tipo detectado, nunca la que envió el usuario. El `accept` y el tipo MIME pueden quedarse como ayuda de interfaz, no como control.',
    },
    label: 'File upload is validated by its name or declared type, not its content',
    severity: 'high',
    check: 16,
    cwe: 'CWE-434',
    source: `${path}:${hit.line}`,
    evidence: `The type is checked with \`${quote}\`, and nothing in the file reads the content (magic bytes, file-type, finfo…).`,
    exploit:
      'The extension, the `accept` attribute and the MIME type are all written by whoever sends the request. A `shell.php` or an `.html` file carrying JavaScript, renamed to `photo.png` and sent with `Content-Type: image/png` from curl, passes every one of those checks — `accept` does not even run, because it lives in the browser.',
    impact:
      'Depending on where it is stored and how it is served, that is stored XSS from your own domain (an SVG or HTML file served as such), code execution if the folder interprets scripts, or malware hosted under your name.',
    why: 'Check the type by the one thing the sender does not choose: the first bytes of the file. Read them on the server — in the route, or in an Edge Function or bucket trigger when the browser uploads straight to storage — and match them against an allowlist (`file-type` in Node, `python-magic` or `filetype` in Python, `finfo` in PHP, `http.DetectContentType` in Go). Store it under a generated name with an extension derived from that detected type, never the one the user sent. `accept` and the MIME type can stay as interface hints, not as the control.',
    references: [
      'https://cwe.mitre.org/data/definitions/434.html',
      'https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html',
    ],
  };
}

/**
 * A file input in served HTML or a compiled bundle — `<input type="file">`, or the
 * `type:"file"` a JSX compiler turns it into. Evidence that the site takes uploads, which a
 * black-box scan can see but cannot judge: what the server does with the bytes is only
 * visible in the code.
 */
const FILE_INPUT = /<input\b[^>]*\btype\s*=\s*["']?file\b|\btype\s*:\s*["']file["']/i;

export function hasFileInput(text: string): boolean {
  return FILE_INPUT.test(text);
}
