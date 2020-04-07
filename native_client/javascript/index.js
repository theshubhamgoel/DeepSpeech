'use strict';

const binary = require('node-pre-gyp');
const path = require('path')
// 'lib', 'binding', 'v0.1.1', ['node', 'v' + process.versions.modules, process.platform, process.arch].join('-'), 'deepspeech-bindings.node')
const binding_path = binary.find(path.resolve(path.join(__dirname, 'package.json')));

// On Windows, we can't rely on RPATH being set to $ORIGIN/../ or on
// @loader_path/../ but we can change the PATH to include the proper directory
// for the dynamic linker
if (process.platform === 'win32') {
  const dslib_path = path.resolve(path.join(binding_path, '../..'));
  var oldPath = process.env.PATH;
  process.env['PATH'] = `${dslib_path};${process.env.PATH}`;
}

const binding = require(binding_path);

if (process.platform === 'win32') {
  process.env['PATH'] = oldPath;
}

/**
 * @class
 * An object providing an interface to a trained DeepSpeech model.
 *
 * @param {string} aModelPath The path to the frozen model graph.
 *
 * @throws on error
 */
function Model(aModelPath) {
    this._impl = null;

    const rets = binding.CreateModel(aModelPath);
    const status = rets[0];
    const impl = rets[1];
    if (status !== 0) {
        throw "CreateModel failed "+binding.ErrorCodeToErrorMessage(status)+" 0x" + status.toString(16);
    }

    this._impl = impl;
}

/**
 * Get beam width value used by the model. If :js:func:Model.setBeamWidth was
 * not called before, will return the default value loaded from the model file.
 *
 * @return {number} Beam width value used by the model.
 */
Model.prototype.beamWidth = function() {
    return binding.GetModelBeamWidth(this._impl);
}

/**
 * Set beam width value used by the model.
 *
 * @param {number} The beam width used by the model. A larger beam width value generates better results at the cost of decoding time.
 *
 * @return {number} Zero on success, non-zero on failure.
 */
Model.prototype.setBeamWidth = function(aBeamWidth) {
    return binding.SetModelBeamWidth(this._impl, aBeamWidth);
}

/**
 * Return the sample rate expected by the model.
 *
 * @return {number} Sample rate.
 */
Model.prototype.sampleRate = function() {
    return binding.GetModelSampleRate(this._impl);
}

/**
 * Enable decoding using an external scorer.
 *
 * @param {string} aScorerPath The path to the external scorer file.
 *
 * @return {number} Zero on success, non-zero on failure (invalid arguments).
 */
Model.prototype.enableExternalScorer = function(aScorerPath) {
    return binding.EnableExternalScorer(this._impl, aScorerPath);
}

/**
 * Disable decoding using an external scorer.
 *
 * @return {number} Zero on success, non-zero on failure (invalid arguments).
 */
Model.prototype.disableExternalScorer = function() {
    return binding.EnableExternalScorer(this._impl);
}

/**
 * Set hyperparameters alpha and beta of the external scorer.
 *
 * @param {float} aLMAlpha The alpha hyperparameter of the CTC decoder. Language Model weight.
 * @param {float} aLMBeta The beta hyperparameter of the CTC decoder. Word insertion weight.
 *
 * @return {number} Zero on success, non-zero on failure (invalid arguments).
 */
Model.prototype.setScorerAlphaBeta = function(aLMAlpha, aLMBeta) {
    return binding.SetScorerAlphaBeta(this._impl, aLMAlpha, aLMBeta);
}

/**
 * Use the DeepSpeech model to perform Speech-To-Text.
 *
 * @param {object} aBuffer A 16-bit, mono raw audio signal at the appropriate sample rate (matching what the model was trained on).
 *
 * @return {string} The STT result. Returns undefined on error.
 */
Model.prototype.stt = function(aBuffer) {
    return binding.SpeechToText(this._impl, aBuffer);
}

/**
 * Use the DeepSpeech model to perform Speech-To-Text and output results including metadata.
 *
 * @param {object} aBuffer A 16-bit, mono raw audio signal at the appropriate sample rate (matching what the model was trained on).
 * @param {number} aNumResults Maximum number of candidate transcripts to return. Returned list might be smaller than this. Default value is 1 if not specified.
 *
 * @return {object} :js:func:`Metadata` object containing multiple candidate transcripts. Each transcript has per-token metadata including timing information. The user is responsible for freeing Metadata by calling :js:func:`FreeMetadata`. Returns undefined on error.
 */
Model.prototype.sttWithMetadata = function(aBuffer, aNumResults) {
    aNumResults = aNumResults || 1;
    return binding.SpeechToTextWithMetadata(this._impl, aBuffer, aNumResults);
}

/**
 * Create a new streaming inference state. One can then call :js:func:`Stream.feedAudioContent` and :js:func:`Stream.finishStream` on the returned stream object.
 *
 * @return {object} a :js:func:`Stream` object that represents the streaming state.
 *
 * @throws on error
 */
Model.prototype.createStream = function() {
    const rets = binding.CreateStream(this._impl);
    const status = rets[0];
    const ctx = rets[1];
    if (status !== 0) {
        throw "CreateStream failed "+binding.ErrorCodeToErrorMessage(status)+" 0x" + status.toString(16);
    }
    return ctx;
}

/**
 * @class
 * Provides an interface to a DeepSpeech stream. The constructor cannot be called
 * directly, use :js:func:`Model.createStream`.
 */
function Stream(nativeStream) {
    this._impl = nativeStream;
}

/**
 * Feed audio samples to an ongoing streaming inference.
 *
 * @param {buffer} aBuffer An array of 16-bit, mono raw audio samples at the
 *                 appropriate sample rate (matching what the model was trained on).
 */
Stream.prototype.feedAudioContent = function(aBuffer) {
    binding.FeedAudioContent(this._impl, aBuffer);
}

/**
 * Compute the intermediate decoding of an ongoing streaming inference.
 *
 * @return {string} The STT intermediate result.
 */
Stream.prototype.intermediateDecode = function() {
    return binding.IntermediateDecode(this._impl);
}

/**
 * Compute the intermediate decoding of an ongoing streaming inference, return results including metadata.
 *
 * @param {number} aNumResults Maximum number of candidate transcripts to return. Returned list might be smaller than this. Default value is 1 if not specified.
 *
 * @return {object} :js:func:`Metadata` object containing multiple candidate transcripts. Each transcript has per-token metadata including timing information. The user is responsible for freeing Metadata by calling :js:func:`FreeMetadata`. Returns undefined on error.
 */
Stream.prototype.intermediateDecodeWithMetadata = function(aNumResults) {
    aNumResults = aNumResults || 1;
    return binding.IntermediateDecode(this._impl, aNumResults);
}

/**
 * Compute the final decoding of an ongoing streaming inference and return the result. Signals the end of an ongoing streaming inference.
 *
 * @return {string} The STT result.
 *
 * This method will free the stream, it must not be used after this method is called.
 */
Stream.prototype.finishStream = function() {
    result = binding.FinishStream(this._impl);
    this._impl = null;
    return result;
}

/**
 * Compute the final decoding of an ongoing streaming inference and return the results including metadata. Signals the end of an ongoing streaming inference.
 *
 * @param {number} aNumResults Maximum number of candidate transcripts to return. Returned list might be smaller than this. Default value is 1 if not specified.
 *
 * @return {object} Outputs a :js:func:`Metadata` struct of individual letters along with their timing information. The user is responsible for freeing Metadata by calling :js:func:`FreeMetadata`.
 *
 * This method will free the stream, it must not be used after this method is called.
 */
Stream.prototype.finishStreamWithMetadata = function(aNumResults) {
    aNumResults = aNumResults || 1;
    result = binding.FinishStreamWithMetadata(this._impl, aNumResults);
    this._impl = null;
    return result;
}


/**
 * Frees associated resources and destroys model object.
 *
 * @param {object} model A model pointer returned by :js:func:`Model`
 *
 */
function FreeModel(model) {
    return binding.FreeModel(model._impl);
}

/**
 * Free memory allocated for metadata information.
 *
 * @param {object} metadata Object containing metadata as returned by :js:func:`Model.sttWithMetadata` or :js:func:`Model.finishStreamWithMetadata`
 */
function FreeMetadata(metadata) {
    return binding.FreeMetadata(metadata);
}

/**
 * Destroy a streaming state without decoding the computed logits. This
 * can be used if you no longer need the result of an ongoing streaming
 * inference and don't want to perform a costly decode operation.
 *
 * @param {Object} stream A stream object returned by :js:func:`Model.createStream`.
 */
function FreeStream(stream) {
    return binding.FreeStream(stream._impl);
}

/**
 * Print version of this library and of the linked TensorFlow library on standard output.
 */
function Version() {
    return binding.Version();
}


//// Metadata, CandidateTranscript and TokenMetadata are here only for documentation purposes

/**
 * @class
 * 
 * Stores text of an individual token, along with its timing information
 */
function TokenMetadata() {}

/** 
 * The text corresponding to this token
 *
 * @return {string} The text generated
 */
TokenMetadata.prototype.text = function() {}

/**
 * Position of the token in units of 20ms
 *
 * @return {int} The position of the token
 */
TokenMetadata.prototype.timestep = function() {};

/**
 * Position of the token in seconds
 *
 * @return {float} The position of the token
 */
TokenMetadata.prototype.start_time = function() {};

/**
 * @class
 *
 * A single transcript computed by the model, including a confidence value and
 * the metadata for its constituent tokens.
 */
function CandidateTranscript () {}

/**
 * Array of tokens
 *
 * @return {array} Array of :js:func:`TokenMetadata`
 */
CandidateTranscript.prototype.tokens = function() {}

/**
 * Approximated confidence value for this transcription. This is roughly the
 * sum of the acoustic model logit values for each timestep/token that
 * contributed to the creation of this transcription.
 *
 * @return {float} Confidence value
 */
CandidateTranscript.prototype.confidence = function() {}

/**
 * @class
 *
 * An array of CandidateTranscript objects computed by the model.
 */
function Metadata () {}

/**
 * Array of transcripts
 *
 * @return {array} Array of :js:func:`CandidateTranscript` objects
 */
Metadata.prototype.transcripts = function() {}


module.exports = {
    Model: Model,
    Metadata: Metadata,
    CandidateTranscript: CandidateTranscript,
    TokenMetadata: TokenMetadata,
    Version: Version,
    FreeModel: FreeModel,
    FreeStream: FreeStream,
    FreeMetadata: FreeMetadata
};
