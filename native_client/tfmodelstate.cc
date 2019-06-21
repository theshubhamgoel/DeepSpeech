#include "tfmodelstate.h"

#include "ds_graph_version.h"

using namespace tensorflow;
using std::vector;

TFModelState::TFModelState()
  : ModelState()
  , mmap_env_(nullptr)
  , session_(nullptr)
{
}

TFModelState::~TFModelState()
{
  if (session_) {
    Status status = session_->Close();
    if (!status.ok()) {
      std::cerr << "Error closing TensorFlow session: " << status << std::endl;
    }
  }
  delete mmap_env_;
}

int
TFModelState::init(const char* model_path,
                   unsigned int n_features,
                   unsigned int n_context,
                   const char* alphabet_path,
                   unsigned int beam_width)
{
  int err = ModelState::init(model_path, n_features, n_context, alphabet_path, beam_width);
  if (err != DS_ERR_OK) {
    return err;
  }

  Status status;
  SessionOptions options;

  mmap_env_ = new MemmappedEnv(Env::Default());

  bool is_mmap = std::string(model_path).find(".pbmm") != std::string::npos;
  if (!is_mmap) {
    std::cerr << "Warning: reading entire model file into memory. Transform model file into an mmapped graph to reduce heap usage." << std::endl;
  } else {
    status = mmap_env_->InitializeFromFile(model_path);
    if (!status.ok()) {
      std::cerr << status << std::endl;
      return DS_ERR_FAIL_INIT_MMAP;
    }

    options.config.mutable_graph_options()
      ->mutable_optimizer_options()
      ->set_opt_level(::OptimizerOptions::L0);
    options.env = mmap_env_;
  }

  status = NewSession(options, &session_);
  if (!status.ok()) {
    std::cerr << status << std::endl;
    return DS_ERR_FAIL_INIT_SESS;
  }

  if (is_mmap) {
    status = ReadBinaryProto(mmap_env_,
                             MemmappedFileSystem::kMemmappedPackageDefaultGraphDef,
                             &graph_def_);
  } else {
    status = ReadBinaryProto(Env::Default(), model_path, &graph_def_);
  }
  if (!status.ok()) {
    std::cerr << status << std::endl;
    return DS_ERR_FAIL_READ_PROTOBUF;
  }

  status = session_->Create(graph_def_);
  if (!status.ok()) {
    std::cerr << status << std::endl;
    return DS_ERR_FAIL_CREATE_SESS;
  }

  int graph_version = graph_def_.version();
  if (graph_version < DS_GRAPH_VERSION) {
    std::cerr << "Specified model file version (" << graph_version << ") is "
              << "incompatible with minimum version supported by this client ("
              << DS_GRAPH_VERSION << "). See "
              << "https://github.com/mozilla/DeepSpeech/#model-compatibility "
              << "for more information" << std::endl;
    return DS_ERR_MODEL_INCOMPATIBLE;
  }

  for (int i = 0; i < graph_def_.node_size(); ++i) {
    NodeDef node = graph_def_.node(i);
    if (node.name() == "input_node") {
      const auto& shape = node.attr().at("shape").shape();
      n_steps_ = shape.dim(1).size();
      n_context_ = (shape.dim(2).size()-1)/2;
      n_features_ = shape.dim(3).size();
      mfcc_feats_per_timestep_ = shape.dim(2).size() * shape.dim(3).size();
    } else if (node.name() == "previous_state_c") {
      const auto& shape = node.attr().at("shape").shape();
      state_size_ = shape.dim(1).size();
    } else if (node.name() == "logits_shape") {
      Tensor logits_shape = Tensor(DT_INT32, TensorShape({3}));
      if (!logits_shape.FromProto(node.attr().at("value").tensor())) {
        continue;
      }

      int final_dim_size = logits_shape.vec<int>()(2) - 1;
      if (final_dim_size != alphabet_->GetSize()) {
        std::cerr << "Error: Alphabet size does not match loaded model: alphabet "
                  << "has size " << alphabet_->GetSize()
                  << ", but model has " << final_dim_size
                  << " classes in its output. Make sure you're passing an alphabet "
                  << "file with the same size as the one used for training."
                  << std::endl;
        return DS_ERR_INVALID_ALPHABET;
      }
    } else if (node.name() == "model_metadata") {
      sample_rate_ = node.attr().at("sample_rate").i();
      int win_len_ms = node.attr().at("feature_win_len").i();
      int win_step_ms = node.attr().at("feature_win_step").i();
      audio_win_len_ = sample_rate_ * (win_len_ms / 1000.0);
      audio_win_step_ = sample_rate_ * (win_step_ms / 1000.0);
    }
  }

  if (n_context_ == -1 || n_features_ == -1) {
    std::cerr << "Error: Could not infer input shape from model file. "
              << "Make sure input_node is a 4D tensor with shape "
              << "[batch_size=1, time, window_size, n_features]."
              << std::endl;
    return DS_ERR_INVALID_SHAPE;
  }

  return DS_ERR_OK;
}

Tensor
tensor_from_vector(const std::vector<float>& vec, const TensorShape& shape)
{
  Tensor ret(DT_FLOAT, shape);
  auto ret_mapped = ret.flat<float>();
  int i;
  for (i = 0; i < vec.size(); ++i) {
    ret_mapped(i) = vec[i];
  }
  for (; i < shape.num_elements(); ++i) {
    ret_mapped(i) = 0.f;
  }
  return ret;
}

void
copy_tensor_to_vector(const Tensor& tensor, vector<float>& vec, int num_elements = -1)
{
  auto tensor_mapped = tensor.flat<float>();
  if (num_elements == -1) {
    num_elements = tensor.shape().num_elements();
  }
  for (int i = 0; i < num_elements; ++i) {
    vec.push_back(tensor_mapped(i));
  }
}

void
TFModelState::infer(const std::vector<float>& mfcc,
                    unsigned int n_frames,
                    const std::vector<float>& previous_state_c,
                    const std::vector<float>& previous_state_h,
                    vector<float>& logits_output,
                    vector<float>& state_c_output,
                    vector<float>& state_h_output)
{
  const size_t num_classes = alphabet_->GetSize() + 1; // +1 for blank

  Tensor input = tensor_from_vector(mfcc, TensorShape({BATCH_SIZE, n_steps_, 2*n_context_+1, n_features_}));
  Tensor previous_state_c_t = tensor_from_vector(previous_state_c, TensorShape({BATCH_SIZE, (long long)state_size_}));
  Tensor previous_state_h_t = tensor_from_vector(previous_state_h, TensorShape({BATCH_SIZE, (long long)state_size_}));

  Tensor input_lengths(DT_INT32, TensorShape({1}));
  input_lengths.scalar<int>()() = n_frames;

  vector<Tensor> outputs;
  Status status = session_->Run(
    {
     {"input_node", input},
     {"input_lengths", input_lengths},
     {"previous_state_c", previous_state_c_t},
     {"previous_state_h", previous_state_h_t}
    },
    {"logits", "new_state_c", "new_state_h"},
    {},
    &outputs);

  if (!status.ok()) {
    std::cerr << "Error running session: " << status << "\n";
    return;
  }

  copy_tensor_to_vector(outputs[0], logits_output, n_frames * BATCH_SIZE * num_classes);

  state_c_output.clear();
  state_c_output.reserve(state_size_);
  copy_tensor_to_vector(outputs[1], state_c_output);

  state_h_output.clear();
  state_h_output.reserve(state_size_);
  copy_tensor_to_vector(outputs[2], state_h_output);
}

void
TFModelState::compute_mfcc(const vector<float>& samples, vector<float>& mfcc_output)
{
  Tensor input = tensor_from_vector(samples, TensorShape({audio_win_len_}));

  vector<Tensor> outputs;
  Status status = session_->Run({{"input_samples", input}}, {"mfccs"}, {}, &outputs);

  if (!status.ok()) {
    std::cerr << "Error running session: " << status << "\n";
    return;
  }

  // The feature computation graph is hardcoded to one audio length for now
  const int n_windows = 1;
  assert(outputs[0].shape().num_elements() / n_features_ == n_windows);
  copy_tensor_to_vector(outputs[0], mfcc_output);
}
