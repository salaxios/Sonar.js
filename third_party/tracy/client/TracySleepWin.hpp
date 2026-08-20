#ifndef TRACY_SLEEPWIN_HPP
#define TRACY_SLEEPWIN_HPP

// Workaround for MinGW/winpthreads stack smashing.
//
// On MinGW-w64, std::this_thread::sleep_for routes through winpthreads'
// __nanosleep -> _pthread_delay_np_ms -> _pthread_wait_for_single_object.
// On some GCC 15 / winpthreads 13 combinations that path intermittently trips
// its own stack-protector canary check ("*** stack smashing detected ***") and
// hard-crashes the process, even with a valid stack. Bypassing it with a plain
// Win32 Sleep() avoids the faulty code path entirely.

#ifdef _WIN32
#  include <windows.h>
namespace tracy {
inline void SleepMs( unsigned ms ) { Sleep( ms ); }
}
#else
#  include <thread>
#  include <chrono>
namespace tracy {
inline void SleepMs( unsigned ms ) { std::this_thread::sleep_for( std::chrono::milliseconds( ms ) ); }
}
#endif

#endif