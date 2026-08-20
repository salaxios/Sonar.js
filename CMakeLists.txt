cmake_minimum_required(VERSION 3.20)
project(rmmz_native C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

# ---------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------
set(THIRD_PARTY_DIR ${CMAKE_SOURCE_DIR}/third_party)

# quickjs-ng
add_subdirectory(${THIRD_PARTY_DIR}/quickjs-ng EXCLUDE_FROM_ALL)

# MSVC < 19.28 has no <stdatomic.h>. quickjs supports disabling atomics
# entirely via __STDC_NO_ATOMICS__; the runtime never uses Atomics.
if(MSVC)
    if(TARGET qjs)
        target_compile_options(qjs PRIVATE "-D__STDC_NO_ATOMICS__")
    elseif(TARGET quickjs)
        target_compile_options(quickjs PRIVATE "-D__STDC_NO_ATOMICS__")
    endif()
endif()

# SDL3
set(SDL_SHARED OFF CACHE BOOL "" FORCE)
set(SDL_STATIC ON CACHE BOOL "" FORCE)
add_subdirectory(${THIRD_PARTY_DIR}/SDL EXCLUDE_FROM_ALL)

# glad
add_library(glad STATIC
    ${THIRD_PARTY_DIR}/glad/src/glad.c
)
target_include_directories(glad PUBLIC ${THIRD_PARTY_DIR}/glad/include)

# stb / miniaudio headers
include_directories(
    ${THIRD_PARTY_DIR}/stb
    ${THIRD_PARTY_DIR}/miniaudio
)

# ---------------------------------------------------------------------
# Tracy profiler client. Vendored under third_party/tracy; enabled with
# TRACY_ENABLE so the running app accepts connections from the Tracy
# profiler GUI (default port 8086). Compile TracyClient.cpp with C++.
# ---------------------------------------------------------------------
add_library(tracy_client STATIC ${THIRD_PARTY_DIR}/tracy/TracyClient.cpp)
target_compile_features(tracy_client PUBLIC cxx_std_11)
target_include_directories(tracy_client PUBLIC ${THIRD_PARTY_DIR}/tracy)
target_compile_definitions(tracy_client PUBLIC TRACY_ENABLE)
if(WIN32)
    target_link_libraries(tracy_client PUBLIC ws2_32 dbghelp secur32)
    target_compile_definitions(tracy_client PUBLIC WINVER=0x0A00 _WIN32_WINNT=0x0A00)
endif()

# ---------------------------------------------------------------------
# Main executable
# ---------------------------------------------------------------------
add_executable(rmmz_native
    src/main.c
    src/native_gl.c
)

# ---------------------------------------------------------------------
# Windows application icon (embedded via .rc resource)
# ---------------------------------------------------------------------
if(WIN32)
    file(TO_CMAKE_PATH "${CMAKE_SOURCE_DIR}/src/icon.ico" ICON_PATH)
    configure_file(${CMAKE_SOURCE_DIR}/src/rmmz_native.rc.in
                   ${CMAKE_BINARY_DIR}/rmmz_native.rc @ONLY)
    target_sources(rmmz_native PRIVATE ${CMAKE_BINARY_DIR}/rmmz_native.rc)
endif()

set(QJS_TARGET quickjs)
if(NOT TARGET quickjs AND TARGET qjs)
    set(QJS_TARGET qjs)
endif()
if(NOT TARGET ${QJS_TARGET})
    message(FATAL_ERROR "Cannot find the quickjs-ng library target (expected `quickjs` or `qjs`).")
endif()

target_link_libraries(rmmz_native PRIVATE
    ${QJS_TARGET}
    SDL3::SDL3
    glad
    tracy_client
)

# System OpenGL
if(APPLE)
    target_link_libraries(rmmz_native PRIVATE "-framework OpenGL")
elseif(WIN32)
    target_link_libraries(rmmz_native PRIVATE opengl32)
else()
    target_link_libraries(rmmz_native PRIVATE GL)
endif()

# ---------------------------------------------------------------------
# MinGW: static-link the whole C/C++ runtime so no GCC DLLs (libstdc++,
# libwinpthread, libgcc) are needed at runtime. System DLLs (kernel32,
# ws2_32, opengl32, ...) stay dynamic as usual.
# ---------------------------------------------------------------------
if(MINGW)
    target_link_options(rmmz_native PRIVATE -static)
endif()

# ---------------------------------------------------------------------
# Post-build: copy shims.js and Project1 next to the executable
# ---------------------------------------------------------------------
# copy_if_different so we never touch the timestamp if unchanged.
add_custom_command(TARGET rmmz_native POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        ${CMAKE_SOURCE_DIR}/src/shims.js
        $<TARGET_FILE_DIR:rmmz_native>/shims.js
)

# shims.js is edited frequently (JS-only, so main.c never relinks). The
# POST_BUILD copy above only runs when rmmz_native itself relinks, which
# would silently ship a stale shims.js on every JS-only change. This ALL
# target forces the copy on EVERY build regardless.
add_custom_target(copy_shims ALL
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        ${CMAKE_SOURCE_DIR}/src/shims.js
        $<TARGET_FILE_DIR:rmmz_native>/shims.js
    DEPENDS ${CMAKE_SOURCE_DIR}/src/shims.js
)

# Bootstrap src/Project1 into the build tree ONLY if build/Project1 does not
# already exist. build/Project1 may be the user's own non-public project, so
# it must never be overwritten by a build (see cmake/copy_project1.cmake).
if(EXISTS ${CMAKE_SOURCE_DIR}/src/Project1)
    add_custom_command(TARGET rmmz_native POST_BUILD
        COMMAND ${CMAKE_COMMAND}
            -DSRC_DIR=${CMAKE_SOURCE_DIR}/src/Project1
            -DDST_DIR=$<TARGET_FILE_DIR:rmmz_native>/Project1
            -P ${CMAKE_SOURCE_DIR}/cmake/copy_project1.cmake
    )
endif()