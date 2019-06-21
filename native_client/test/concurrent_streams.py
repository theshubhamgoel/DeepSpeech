#!/usr/bin/env python
# -*- coding: utf-8 -*-
from __future__ import absolute_import, division, print_function

import argparse
import numpy as np
import wave

from deepspeech import Model


# These constants control the beam search decoder

# Beam width used in the CTC decoder when building candidate transcriptions
BEAM_WIDTH = 500

# The alpha hyperparameter of the CTC decoder. Language Model weight
LM_ALPHA = 0.75

# The beta hyperparameter of the CTC decoder. Word insertion bonus.
LM_BETA = 1.85


# These constants are tied to the shape of the graph used (changing them changes
# the geometry of the first layer), so make sure you use the same constants that
# were used during training

# Number of MFCC features to use
N_FEATURES = 26

# Size of the context window used for producing timesteps in the input vector
N_CONTEXT = 9


def main():
    parser = argparse.ArgumentParser(description='Running DeepSpeech inference.')
    parser.add_argument('--model', required=True,
                        help='Path to the model (protocol buffer binary file)')
    parser.add_argument('--alphabet', required=True,
                        help='Path to the configuration file specifying the alphabet used by the network')
    parser.add_argument('--lm', nargs='?',
                        help='Path to the language model binary file')
    parser.add_argument('--trie', nargs='?',
                        help='Path to the language model trie file created with native_client/generate_trie')
    parser.add_argument('--audio1', required=True,
                        help='First audio file to use in interleaved streams')
    parser.add_argument('--audio2', required=True,
                        help='Second audio file to use in interleaved streams')
    args = parser.parse_args()

    ds = Model(args.model, N_FEATURES, N_CONTEXT, args.alphabet, BEAM_WIDTH)

    if args.lm and args.trie:
        ds.enableDecoderWithLM(args.alphabet, args.lm, args.trie, LM_ALPHA, LM_BETA)

    with wave.open(args.audio1, 'rb') as fin:
        fs1 = fin.getframerate()
        audio1 = np.frombuffer(fin.readframes(fin.getnframes()), np.int16)

    with wave.open(args.audio2, 'rb') as fin:
        fs2 = fin.getframerate()
        audio2 = np.frombuffer(fin.readframes(fin.getnframes()), np.int16)

    stream1 = ds.setupStream(sample_rate=fs1)
    stream2 = ds.setupStream(sample_rate=fs2)

    splits1 = np.array_split(audio1, 10)
    splits2 = np.array_split(audio2, 10)

    for part1, part2 in zip(splits1, splits2):
        ds.feedAudioContent(stream1, part1)
        ds.feedAudioContent(stream2, part2)

    print(ds.finishStream(stream1))
    print(ds.finishStream(stream2))

if __name__ == '__main__':
    main()
