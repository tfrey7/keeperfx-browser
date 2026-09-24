/*
 * OpenAL Soft extension names Emscripten's OpenAL does not declare. bflib_sndlib.cpp uses the
 * MSADPCM formats only as tags while reading a WAV (it converts mono ADPCM to 8-bit PCM itself and
 * refuses stereo), so they never reach alBufferData. Values are OpenAL Soft's own (alext.h,
 * AL_SOFT_MSADPCM). Force-included (-include) into every engine source, so no upstream file
 * changes. See docs/PORTING-NOTES.md.
 */
#ifndef KFX_WEB_AL_COMPAT_H
#define KFX_WEB_AL_COMPAT_H

#ifndef AL_FORMAT_MONO_MSADPCM_SOFT
#define AL_FORMAT_MONO_MSADPCM_SOFT 0x1302
#endif
#ifndef AL_FORMAT_STEREO_MSADPCM_SOFT
#define AL_FORMAT_STEREO_MSADPCM_SOFT 0x1303
#endif

#endif
