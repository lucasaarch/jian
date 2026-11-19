import type { Skill } from '@jian/contracts';

/**
 * Where the commands run decides the tool, how a file is written there, and how an image made
 * there reaches the conversation. A conversation aimed at a machine has no `run_command`, and
 * `send_file` reads only the gateway's disk, so its run is told the remote way instead.
 */
type Place = { run: string; write: string; show: string };

const HERE: Place = {
  run: 'Every step is a command, with `run_command` (`shell` group).',
  write: '`write_file`',
  show: `Show it with \`send_file\` by \`path\` (on a chat channel the person gets it too); the
result gives its \`mediaId\`.`,
};

const onMachine = (files: boolean): Place => ({
  run: `This conversation works on a connected machine: run every step there with
\`run_remote_command\`, on macOS or Linux (the recipes are \`/bin/sh\`). \`send_file\` reads the
gateway's disk: \`pull_remote_file\` brings at most 300,000 bytes of the machine's into the
conversation, so a video stays there, and you say where.`,
  write: files ? '`write_file`' : '`push_remote_file`',
  show: `Bring it over with \`pull_remote_file\` (scale it under 300,000 bytes), which gives its
\`mediaId\`.`,
});

const body = (place: Place) => `# Producing a short video

${place.run}

Keep video work in \`~/video\` (on the owner's own computer, \`~/Jian/video\`): a job in
\`jobs/<date>-<name>\`, run there (\`cwd\`), and the library in \`library\`. Each command is a
new shell: set a variable in the command that uses it.

## The pipeline

1. **Script**: about 2.5 spoken words a second, 75 for 30 seconds; one line per shot.
2. **Narration**: if the owner connected ElevenLabs in Plugins, there, in the team's voice;
   otherwise \`generate_speech\` when this run has it, or the owner's recording
   (\`save_attachment\`). Then treat it (Audio).
3. **Picture**: if HeyGen is connected in Plugins, a talking avatar; if Higgsfield is, generated
   images and clips (download with \`curl -L -o\`). Otherwise library b-roll or the owner's footage.
4. **Assembly**: normalize every clip, cut, join, headline, music, captions.
5. **Check**, then send a preview.

A connected service is reached as the \`mcp-servers\` skill says. Without one, say what it would add.

First: \`for t in ffmpeg ffprobe jq uv convert montage mediainfo sox; do command -v $t >/dev/null
|| echo "missing $t"; done\`. ffmpeg and jq are needed, and uv for captions; ImageMagick,
mediainfo and sox are missing on older images and many machines. \`fc-list | grep -c Noto\`: without Noto, text falls back to
another font. \`df -h ~\`: a minute of 1080×1920 takes hundreds of MB in intermediates.

## Audio

From \`voice-raw.wav\`: pauses cut to 0.3 s, peaks limited, 5% faster, two-pass loudness to
−12 LUFS and −1 dBTP, WAV and MP3 at 48 kHz mono, and one file per line, split at the pauses.

\`\`\`sh
ffmpeg -y -i voice-raw.wav -af "silenceremove=stop_periods=-1:stop_duration=0.3:stop_threshold=-40dB,alimiter=limit=0.35:level=false,atempo=1.05" -ar 48000 -ac 1 tight.wav
ffmpeg -nostats -i tight.wav -af silencedetect=noise=-40dB:d=0.25 -f null - 2>&1 | awk '/silence_start/{s=$NF} /silence_end/{printf "%s%.3f", c, (s+$5)/2; c=","}' > cuts.txt
ffmpeg -nostats -i tight.wav -af loudnorm=I=-12:TP=-1:LRA=11:print_format=json -f null - 2>&1 | sed -n '/^{/,/^}/p' > loud.json
af=$(jq -r '"loudnorm=I=-12:TP=-1:LRA=11:measured_I=\\(.input_i):measured_TP=\\(.input_tp):measured_LRA=\\(.input_lra):measured_thresh=\\(.input_thresh):offset=\\(.target_offset):linear=true"' loud.json)
ffmpeg -y -i tight.wav -af "$af" -ar 48000 -ac 1 voice.wav
ffmpeg -y -i voice.wav -c:a libmp3lame -b:a 192k voice.mp3
ffmpeg -y -i voice.wav -f segment -segment_times "$(cat cuts.txt)" -c copy line-%02d.wav
\`\`\`

−12 LUFS under −1 dBTP needs peaks at most about 11 dB over the loudness: the limiter cuts
them, for a voice that peaks near 0 dB, as a generated one does. Raise a quiet recording first
(\`volume=…dB\`); if the check reads under −12, lower \`limit\`. Pauses are found before
loudness, which lifts the noise above −40 dB; a noisy recording needs about -35dB. ffmpeg
versions count \`stop_duration\` differently: measure what is left with
\`silencedetect=noise=-40dB:d=0.1\` and \`grep -o 'silence_duration: [0-9.]*'\`.

## Picture

Every clip to 1080×1920, 30 fps, H.264, AAC 48 kHz stereo, silence added where a clip has no
audio, so they join without re-encoding. \`fill\` crops; \`fit\` pads with black.

\`\`\`sh
fill="scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,format=yuv420p"
fit="scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p"
enc="-c:v libx264 -preset medium -crf 20 -c:a aac -b:a 192k -ar 48000 -ac 2 -movflags +faststart"
a=1:a; [ -n "$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 in.mp4)" ] && a=0:a:0
ffmpeg -y -i in.mp4 -f lavfi -i anullsrc=r=48000:cl=stereo -map 0:v:0 -map $a -shortest -vf "$fill" $enc seg-01.mp4
ffmpeg -y -ss 2.5 -to 6 -i seg-01.mp4 $enc cut-01.mp4
printf "file '%s'\\n" cut-01.mp4 seg-02.mp4 > list.txt
ffmpeg -y -f concat -safe 0 -i list.txt -c copy -movflags +faststart joined.mp4
\`\`\`

A headline over the first 3 seconds, then music under the voice, ducked while it speaks (a lower
\`ratio\` ducks less). \`fc-match\` always answers: check it named the font you want.

\`\`\`sh
font=$(fc-match -f '%{file}' 'Noto Sans:bold')
convert -background none -fill white -stroke black -strokewidth 4 -font "$font" -pointsize 88 -size 960x -gravity center caption:'Coffee before your alarm' headline.png
ffmpeg -y -i joined.mp4 -i headline.png -filter_complex "[0:v][1:v]overlay=(W-w)/2:220:enable='between(t,0,3)'" -c:v libx264 -crf 20 -c:a copy headed.mp4
fc="[1:a]aresample=48000,aformat=channel_layouts=stereo,apad,asplit=2[v1][v2];[2:a]aresample=48000,aformat=channel_layouts=stereo,volume=0.25[m];[m][v1]sidechaincompress=threshold=0.02:ratio=10:attack=20:release=400[duck];[v2][duck]amix=inputs=2:duration=first:normalize=0[a]"
ffmpeg -y -i headed.mp4 -i voice.wav -stream_loop -1 -i music.mp3 -filter_complex "$fc" -map 0:v -map "[a]" -shortest -c:v copy -c:a aac -b:a 192k -ar 48000 mixed.mp4
\`\`\`

## Captions

Word timings, free, from faster-whisper on the CPU. Write \`words.py\` with ${place.write}:

\`\`\`python
import json, sys
from faster_whisper import WhisperModel
audio, lang, size = sys.argv[1], sys.argv[2], sys.argv[3]
model = WhisperModel(size, device="cpu", compute_type="int8")
segments, _ = model.transcribe(audio, language=lang, word_timestamps=True, vad_filter=True)
words = [{"word": w.word.strip(), "start": round(w.start, 2), "end": round(w.end, 2)} for s in segments for w in s.words]
json.dump(words, open("words.json", "w"), ensure_ascii=False, indent=1)
\`\`\`

\`uv run --with faster-whisper python words.py voice.wav en base\`, with the language's code
(\`en\`, \`pt\`, \`es\`). Then fix the words against the script, keeping the times; given the
script as a prompt, \`base\` invented a sentence. \`tiny\` and \`base\` take seconds for 30
seconds of speech; \`small\`, about four times longer, hears accents better. The first run
downloads the model, up to a few hundred MB.

\`head.ass\` has two styles: \`Caption\`, plain at the bottom, and \`Karaoke\`, centred, each word
turning from white to gold as it is said. Colours are \`&H00BBGGRR\`: \`#RRGGBB\` reversed.

\`\`\`text
[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Noto Sans,64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,4,0,2,80,80,260,1
Style: Karaoke,Noto Sans,76,&H0000D7FF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,5,0,5,80,80,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
\`\`\`

\`ass.py\` writes a line per four words; \`{\\k<centiseconds>}\` holds a word until the next starts:

\`\`\`python
import json, sys
style = sys.argv[1]
t = lambda s: f"{int(s // 3600)}:{int(s % 3600 // 60):02}:{s % 60:05.2f}"
w = json.load(open("words.json"))
with open("captions.ass", "a") as out:
    for i in range(0, len(w), 4):
        g = w[i:i + 4]
        ends = [x["start"] for x in g[1:]] + [g[-1]["end"]]
        k = style == "Karaoke"
        text = " ".join((f"{{\\\\k{round((e - x['start']) * 100)}}}" if k else "") + x["word"] for x, e in zip(g, ends))
        out.write(f"Dialogue: 0,{t(g[0]['start'])},{t(g[-1]['end'])},{style},,0,0,0,,{text}\\n")
\`\`\`

\`cp head.ass captions.ass && python3 ass.py Karaoke\`, then
\`ffmpeg -y -i mixed.mp4 -vf ass=captions.ass -c:v libx264 -crf 20 -c:a copy final.mp4\`.

## Check, then send

\`\`\`sh
ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate,sample_rate:format=duration -of compact=p=0 final.mp4
ffmpeg -nostats -i final.mp4 -af ebur128=peak=true -f null - 2>&1 | sed -n '/Summary/,$p' | grep -E 'I:|Peak:'
\`\`\`

Look at frames too: \`ffmpeg -y -ss 1.5 -i final.mp4 -frames:v 1 -q:v 2 thumb.jpg\`. Four frames
of a clip in one sheet: \`d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 clip.mp4)\`,
then \`ffmpeg -y -i clip.mp4 -vf "fps=4/$d,scale=-2:480,tile=4x1:padding=6" -frames:v 1 sheet.jpg\`;
several, labelled by name: \`montage -font "$(fc-match -f '%{file}' 'Noto Sans')" -label '%t'
sheets/*.jpg -tile 1x -geometry +0+12 -pointsize 28 batch.jpg\`. ${place.show} Then \`analyze_media\` it.

A file sent in a conversation is at most 16 MB: send a preview, about 15 MB at any length, and
say where the full file is. A still is \`thumb.jpg\`.

\`\`\`sh
d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 final.mp4)
k=$(awk -v d="$d" 'BEGIN { printf "%d", 120000 / d - 128 }')
ffmpeg -y -i final.mp4 -vf scale=720:-2 -c:v libx264 -preset veryfast -crf 23 -maxrate "$k"k -bufsize "$k"k -c:a aac -b:a 96k -movflags +faststart preview.mp4
ffmpeg -y -t 6 -i final.mp4 -vf "fps=12,scale=320:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" preview.gif
\`\`\`

Then delete the intermediates you made: \`tight.wav\`, \`seg-*\`, \`cut-*\`, \`joined.mp4\`.

## Long jobs

A command stops after two minutes at most (\`timeoutMs\` 120000), and a tool with no sign of
life for five minutes stops the turn. Start a render or a transcription in the background, with
\`cwd\` the job folder and nothing chained before it (after \`cd x &&\` the call waits for the job):

\`nohup sh -c 'ffmpeg -nostdin -y -progress render.progress … && touch render.done || touch
render.failed' > render.log 2>&1 < /dev/null &\`

Check with short commands, \`ls *.done *.failed; grep -E '^(out_time|progress)=' render.progress
| tail -n 2\`, doing other work between them; \`render.log\` says why one failed.

For a wait past the turn, such as a render at a service, tell the owner, then make a schedule a
few minutes out (\`schedules\` skill) whose instruction names the job folder, the render's id
and what to do next. Prefer a tool that starts a render and returns its id to one that waits.

## Library

\`library/broll/<topic>/\`, \`library/music/<mood>/\`, and \`library/catalog.json\`, a list of
\`{"path": "broll/kitchen/pour-01.mp4", "seconds": 6.2, "size": "1080x1920", "tags": ["coffee",
"pouring", "close-up"], "notes": "steam, no people"}\`; music adds \`"mood"\` and \`"bpm"\`. For
each clip without an entry, make its sheet, look at a batch, and write tags from what you saw,
never from the name alone.

For each script line, match its nouns and actions to tags; take a clip at least as long as the
line (\`line-NN.wav\`), vertical first, unlike the previous shot. When none fits, say so and
offer a generated clip, if a service is connected, or ask for footage.

## Team defaults

When the owner states one (an ElevenLabs voice id, a HeyGen avatar, brand fonts and colours,
caption style, music mood, an end card), save it with \`remember\` after searching
\`read_memories\` (\`memory-keeping\` skill). Read them before each video.`;

export function videoProductionFor(machine?: { files: boolean }): Skill {
  return {
    name: 'video-production',
    description:
      'Use when making a short video or ad from a script: narration, audio clean-up, an avatar or generated footage, b-roll, captions, a headline and music, checking the result; or when keeping a library of clips and music.',
    instructions: body(machine ? onMachine(machine.files) : HERE),
  };
}

/** As the panel lists it, for a run whose commands run where the gateway does. */
export const videoProduction: Skill = videoProductionFor();
