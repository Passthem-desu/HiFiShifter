cmake_minimum_required(VERSION 3.15)

project(world_dll LANGUAGES C CXX)

# This project builds mmorise/WORLD as a Windows DLL for runtime dynamic loading.
# We keep the upstream repo intact and build via an out-of-tree CMake project.

set(WORLD_SRC_DIR "${CMAKE_CURRENT_LIST_DIR}/../source/World")

if (NOT EXISTS "${WORLD_SRC_DIR}/src/cheaptrick.cpp")
  message(FATAL_ERROR "WORLD source not found at: ${WORLD_SRC_DIR} (did you git clone it?)")
endif()

# Export all global symbols on Windows (includes WORLD's extern "C" APIs).
set(CMAKE_WINDOWS_EXPORT_ALL_SYMBOLS ON)

add_library(world_dll SHARED
  ${WORLD_SRC_DIR}/src/cheaptrick.cpp
  ${WORLD_SRC_DIR}/src/codec.cpp
  ${WORLD_SRC_DIR}/src/common.cpp
  ${WORLD_SRC_DIR}/src/d4c.cpp
  ${WORLD_SRC_DIR}/src/dio.cpp
  ${WORLD_SRC_DIR}/src/fft.cpp
  ${WORLD_SRC_DIR}/src/harvest.cpp
  ${WORLD_SRC_DIR}/src/matlabfunctions.cpp
  ${WORLD_SRC_DIR}/src/stonemask.cpp
  ${WORLD_SRC_DIR}/src/synthesis.cpp
  ${WORLD_SRC_DIR}/src/synthesisrealtime.cpp
)

target_include_directories(world_dll PRIVATE
  ${WORLD_SRC_DIR}/src
)

target_compile_features(world_dll PRIVATE cxx_std_11)

# WORLD does not require RTTI/exceptions, but we keep defaults to match upstream.

# Output layout
set_target_properties(world_dll PROPERTIES
  OUTPUT_NAME "world"
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
  LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
  ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/lib"
)
