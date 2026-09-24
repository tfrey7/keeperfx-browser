/*
 * KFX_NO_NET: the web build's stand-in for KeeperFX's five networking files
 * (bflib_enet.cpp, net_lan.c, net_holepunch.c, net_matchmaking.c, net_portforward.cpp).
 *
 * Browsers have no raw UDP, so enet6, curl, UPnP and NAT-PMP are not built. This file keeps
 * the same API with nothing behind it: InitEnetSP fails, so the engine's own code reports that
 * multiplayer is unavailable, and every other call does nothing. No game logic lives here;
 * the rest of net_*.c is compiled unchanged. See docs/PORTING-NOTES.md.
 */
#include "pre_inc.h"
#include "bflib_enet.h"
#include "net_lan.h"
#include "net_holepunch.h"
#include "net_matchmaking.h"
#include "net_portforward.h"
#include "post_inc.h"

/* bflib_enet.h */
uint16_t enet_port = ENET_DEFAULT_PORT;
uint16_t external_ipv4_port = 0;
char external_ipv4_address[64] = {0};
int skip_holepunch = 0;

struct NetSP *InitEnetSP() { return NULL; }
unsigned long GetPing(int id) { (void)id; return 0; }
unsigned int GetPacketLoss(int id) { (void)id; return 0; }
unsigned int GetClientDataInTransit() { return 0; }
unsigned int GetClientPacketsLost() { return 0; }
unsigned int GetUploadRateBytesPerSecond() { return 0; }
unsigned int GetDownloadRateBytesPerSecond() { return 0; }
int enet_matchmaking_host_update(void) { return 0; }
uint16_t enet_get_bound_ipv6_port(void) { return 0; }

/* net_lan.h */
struct TbNetworkSessionNameEntry lan_sessions[LAN_SESSIONS_MAX];
int lan_session_count = 0;
void lan_host_start(const char *name, uint16_t port) { (void)name; (void)port; }
void lan_host_update(void) {}
void lan_refresh_sessions(void) {}
void lan_shutdown(void) {}
void lan_set_lobby_id(const char *id) { (void)id; }

/* net_holepunch.h */
uint16_t holepunch_stun_query(struct _ENetHost *host, char *output_ip, size_t output_ip_buffer_size)
{
    (void)host;
    if (output_ip != NULL && output_ip_buffer_size > 0)
        output_ip[0] = 0;
    return 0;
}
int holepunch_handle_packet(struct _ENetHost *host, struct _ENetAddress *expected, size_t expected_count, int *received_mask)
{
    (void)host; (void)expected; (void)expected_count; (void)received_mask;
    return 0;
}
void holepunch_stun_keepalive(struct _ENetHost *host) { (void)host; }
void holepunch_punch_to(struct _ENetHost *host, const struct _ENetAddress *target) { (void)host; (void)target; }

/* net_matchmaking.h: switched off, as upstream does when no server is configured */
struct TbNetworkSessionNameEntry matchmaking_sessions[MATCHMAKING_SESSIONS_MAX];
TbBool matchmaking_enabled = 0;
char matchmaking_ws_url[MATCHMAKING_URL_MAX] = {0};
char matchmaking_ip_url[MATCHMAKING_URL_MAX] = {0};
int matchmaking_session_count = 0;
char join_lobby_id[MATCHMAKING_ID_MAX] = {0};

void matchmaking_set_server(const char *host) { (void)host; }
void matchmaking_connect_async(void) {}
int matchmaking_connect(void) { return -1; }
int matchmaking_request_list(void) { return -1; }
void matchmaking_disconnect(void) {}
void matchmaking_finish_lobby(enum MatchmakingLobbyResult result, int map_number, const char *map_name)
{
    (void)result; (void)map_number; (void)map_name;
}
void matchmaking_refresh_sessions(void) {}
int matchmaking_create(const char *name, const char *udp_ipv4, int udp_ipv4_port, int udp_ipv6_port, int direct_ipv4_port)
{
    (void)name; (void)udp_ipv4; (void)udp_ipv4_port; (void)udp_ipv6_port; (void)direct_ipv4_port;
    return -1;
}
int matchmaking_punch(const char *lobby_id, const char *udp_ipv4, int udp_ipv4_port, int udp_ipv6_port, PunchAddresses *output)
{
    (void)lobby_id; (void)udp_ipv4; (void)udp_ipv4_port; (void)udp_ipv6_port; (void)output;
    return -1;
}
int matchmaking_poll_punch(PunchAddresses *output) { (void)output; return -1; }

/* net_portforward.h */
int port_forward_add_mapping(uint16_t port) { (void)port; return 0; }
void port_forward_remove_mapping(void) {}
