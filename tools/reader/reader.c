/*
 * A stand-in for the engine, until the engine itself is built: it lists the player's game files
 * from the folders KeeperFX reads (data/, sound/ and music/ under its game directory) with plain
 * C stdio, the same calls the engine makes. Every file is opened and read to the end, so a name
 * listed here is a file the engine can load. Built by scripts/build_reader.py.
 */
#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten/emscripten.h>

#define MAX_FILES 64

static int by_name(const void *a, const void *b)
{
    return strcmp(*(const char *const *)a, *(const char *const *)b);
}

/* Opens the file and reads it to the end; returns its length, or -1 when it cannot be read. */
static long read_length(const char *path)
{
    FILE *f = fopen(path, "rb");
    if (f == NULL)
        return -1;
    char buf[4096];
    long total = 0;
    size_t got;
    while ((got = fread(buf, 1, sizeof(buf), f)) > 0)
        total += (long)got;
    fclose(f);
    return total;
}

/* Lists one folder in name order; returns how many of its files could be read. */
static int list_folder(const char *root, const char *folder)
{
    char dirpath[512];
    snprintf(dirpath, sizeof(dirpath), "%s/%s", root, folder);
    DIR *dir = opendir(dirpath);
    if (dir == NULL)
        return 0;

    char *names[MAX_FILES];
    int count = 0;
    struct dirent *entry;
    while ((entry = readdir(dir)) != NULL && count < MAX_FILES) {
        if (entry->d_name[0] != '.')
            names[count++] = strdup(entry->d_name);
    }
    closedir(dir);
    qsort(names, count, sizeof(names[0]), by_name);

    int readable = 0;
    for (int i = 0; i < count; i++) {
        char path[768];
        snprintf(path, sizeof(path), "%s/%s", dirpath, names[i]);
        long length = read_length(path);
        if (length < 0) {
            printf("%-34s cannot be read\n", path);
        } else {
            printf("%-34s %6ld bytes\n", path, length);
            readable++;
        }
        free(names[i]);
    }
    return readable;
}

EMSCRIPTEN_KEEPALIVE
int list_game_files(const char *root)
{
    int readable = 0;
    readable += list_folder(root, "data");
    readable += list_folder(root, "sound");
    readable += list_folder(root, "music");
    printf("%d files readable\n", readable);
    fflush(stdout);
    return readable;
}
