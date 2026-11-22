/** The speech-to-text models (Whisper, via Transformers.js), shared by the editor and the app's model cache. */
export const WHISPER_MODELS = {
  fast: { id: 'onnx-community/whisper-tiny_timestamped', label: 'Fast', size: '≈45 MB' },
  accurate: { id: 'onnx-community/whisper-base_timestamped', label: 'Accurate', size: '≈90 MB' }
} as const

export type WhisperModel = keyof typeof WHISPER_MODELS

/**
 * The files Transformers.js loads for a Whisper model on the CPU (8-bit weights). Used to download a
 * model ahead of time; anything missing from this list is still fetched (and kept) on first use.
 */
export const WHISPER_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx'
] as const

/** The app's own scheme for model files: toom-models://hf/<repo>/resolve/<revision>/<file> */
export const MODELS_SCHEME = 'toom-models'
