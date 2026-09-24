/*
 * LuaJIT -> PUC Lua 5.1.5 for the web build. LuaJIT's JIT cannot target WebAssembly; its C API is
 * Lua 5.1's plus a few 5.2 additions, and these are the ones KeeperFX uses. Force-included
 * (-include) into every engine source, so no upstream file changes. See docs/PORTING-NOTES.md.
 */
#ifndef KFX_WEB_LUA_COMPAT_H
#define KFX_WEB_LUA_COMPAT_H

/* Lua is compiled as C; some engine C++ files include lua.h outside extern "C". Including the
 * headers here first, inside extern "C", makes their later includes no-ops. */
#ifdef __cplusplus
extern "C" {
#endif
#include <lua.h>
#include <lauxlib.h>
#include <lualib.h>
#ifdef __cplusplus
}
#endif

#ifndef LUA_OK
#define LUA_OK 0
#endif

#define lua_rawlen(L, i) lua_objlen((L), (i))

/* Lua 5.2's luaL_setfuncs: register l into the table below nup upvalues, each function
 * sharing those upvalues, then pop the upvalues. */
static inline void luaL_setfuncs(lua_State *L, const luaL_Reg *l, int nup)
{
    luaL_checkstack(L, nup, "too many upvalues");
    for (; l->name != NULL; l++) {
        int i;
        for (i = 0; i < nup; i++)
            lua_pushvalue(L, -nup);
        lua_pushcclosure(L, l->func, nup);
        lua_setfield(L, -(nup + 2), l->name);
    }
    lua_pop(L, nup);
}

#define luaL_newlibtable(L, l) lua_createtable((L), 0, sizeof(l) / sizeof((l)[0]) - 1)
#define luaL_newlib(L, l) (luaL_newlibtable((L), (l)), luaL_setfuncs((L), (l), 0))

#endif
