#pragma once

#include <algorithm>
#include <array>
#include <atomic>
#include <pthread.h>
#include <stdexcept>

#include <emscripten/threading.h>

// LibRaw exposes independent compressed blocks but its WASM toolchain does not
// ship libomp. Keep the replacement deliberately small: the calling thread and
// at most three pooled pthreads claim indices from one counter.
template <typename Function>
void libraw_parallel_for(int count, Function function) {
  const int thread_count =
      std::min({count, 4, emscripten_num_logical_cores()});
  if (thread_count <= 1) {
    for (int index = 0; index < count; ++index) function(index);
    return;
  }

  struct Work {
    std::atomic<int> next{0};
    int count;
    Function *function;
  } work;
  work.count = count;
  work.function = &function;
  const auto run = [](void *opaque) -> void * {
    auto &work = *static_cast<Work *>(opaque);
    for (;;) {
      const int index = work.next.fetch_add(1, std::memory_order_relaxed);
      if (index >= work.count) return nullptr;
      (*work.function)(index);
    }
  };

  std::array<pthread_t, 3> threads{};
  int started = 0;
  for (; started < thread_count - 1; ++started) {
    if (pthread_create(&threads[started], nullptr, run, &work) != 0) break;
  }
  run(&work);
  for (int index = 0; index < started; ++index) {
    pthread_join(threads[index], nullptr);
  }
  if (started != thread_count - 1) {
    throw std::runtime_error("Could not start the LibRaw decoder thread pool");
  }
}
