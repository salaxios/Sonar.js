# Wrapper CMakeLists.txt for Bellard's QuickJS (no native CMake support)
cmake_minimum_required(VERSION 3.20)
project(quickjs_wrapper C)

set(QUICKJS_DIR ${CMAKE_CURRENT_SOURCE_DIR}/src)

# Build libquickjs from source
add_library(quickjs STATIC
    ${QUICKJS_DIR}/quickjs.c
    ${QUICKJS_DIR}/cutils.c
    ${QUICKJS_DIR}/libregexp.c
    ${QUICKJS_DIR}/libunicode.c
    ${QUICKJS_DIR}/dtoa.c
    ${QUICKJS_DIR}/quickjs-libc.c
)

target_include_directories(quickjs PUBLIC ${QUICKJS_DIR})
file(READ ${QUICKJS_DIR}/VERSION QUICKJS_VERSION)
string(STRIP "${QUICKJS_VERSION}" QUICKJS_VERSION)

target_compile_definitions(quickjs PRIVATE
    _GNU_SOURCE
    CONFIG_VERSION="${QUICKJS_VERSION}"
)
target_compile_features(quickjs PRIVATE c_std_11)

if(WIN32)
    target_compile_definitions(quickjs PRIVATE __USE_MINGW_ANSI_STDIO)
endif()

# Math library
find_library(M_LIBRARIES m)
if(M_LIBRARIES)
    target_link_libraries(quickjs PRIVATE m)
endif()

# Threading (for quickjs-libc worker support, optional)
find_package(Threads)
if(CMAKE_THREAD_LIBS_INIT)
    target_link_libraries(quickjs PRIVATE ${CMAKE_THREAD_LIBS_INIT})
endif()
