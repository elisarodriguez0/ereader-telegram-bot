local Dispatcher = require("dispatcher")
local InfoMessage = require("ui/widget/infomessage")
local UIManager = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local JSON = require("json")
local lfs = require("libs/libkoreader-lfs")
local ltn12 = require("ltn12")
local socket = require("socket")
local http = require("socket.http")
local socketutil = require("socketutil")
local _ = require("gettext")

local config = require("config")

local BOOKS_DIR = "/mnt/us/Books"
local WALLPAPERS_DIR = "/mnt/us/screensaver"

local EreaderSync = WidgetContainer:extend{
    name = "ereader-sync",
    is_doc_only = false,
}

function EreaderSync:init()
    self:onDispatcherRegisterActions()
    self.ui.menu:registerToMainMenu(self)
end

function EreaderSync:onDispatcherRegisterActions()
    Dispatcher:registerAction(
        "ereader_sync_all",
        {
            category = "none",
            event = "EreaderSyncAll",
            title = _("Ereader Sync: Sync all"),
            general = true,
        }
    )

    Dispatcher:registerAction(
        "ereader_sync_status",
        {
            category = "none",
            event = "EreaderSyncStatus",
            title = _("Ereader Sync: Status"),
            general = true,
        }
    )
end

function EreaderSync:addToMainMenu(menu_items)
    menu_items.ereader_sync = {
        text = _("Ereader Sync"),

        sub_item_table = {
            {
                text = _("Sync all"),
                callback = function()
                    self:onEreaderSyncAll()
                end,
            },
            {
                text = _("Status"),
                callback = function()
                    self:onEreaderSyncStatus()
                end,
            },
        },
    }
end

function EreaderSync:fetchManifest()
    local sink = {}

    local manifest_url =
        config.base_url
        .. "/manifest?token="
        .. config.library_token

    socketutil:set_timeout(
        socketutil.LARGE_BLOCK_TIMEOUT,
        socketutil.LARGE_TOTAL_TIMEOUT
    )

    local request = {
        url = manifest_url,
        method = "GET",
        headers = {
            ["Accept"] = "application/json",
            ["Accept-Encoding"] = "identity",
        },
        sink = ltn12.sink.table(sink),
    }

    local code, headers, status =
        socket.skip(1, http.request(request))

    socketutil:reset_timeout()

    if headers == nil then
        return nil, status or code or "Network unreachable"
    end

    if code ~= 200 then
        return nil,
            "HTTP "
            .. tostring(code)
            .. ": "
            .. tostring(status or "Request failed")
    end

    local body = table.concat(sink)

    if body == "" then
        return nil, "Server returned an empty response"
    end

    local ok, manifest = pcall(
        JSON.decode,
        body,
        JSON.decode.simple
    )

    if not ok or not manifest then
        return nil, "Could not parse manifest JSON"
    end

    return manifest, nil
end

function EreaderSync:safeFileName(file_name)
    if not file_name or file_name == "" then
        return nil
    end

    local safe_name = file_name
        :gsub("/", "_")
        :gsub("\\", "_")
        :gsub("%z", "")
        :gsub("^%s+", "")
        :gsub("%s+$", "")

    if safe_name == "" or safe_name == "." or safe_name == ".." then
        return nil
    end

    return safe_name
end

function EreaderSync:fileExists(path)
    local attributes = lfs.attributes(path)

    return attributes ~= nil
        and attributes.mode == "file"
end

function EreaderSync:downloadFile(url, destination)
    local temporary_path = destination .. ".part"

    os.remove(temporary_path)

    local file, open_error = io.open(
        temporary_path,
        "wb"
    )

    if not file then
        return false,
            "Could not create temporary file: "
            .. tostring(open_error)
    end

    socketutil:set_timeout(
        socketutil.LARGE_BLOCK_TIMEOUT,
        socketutil.LARGE_TOTAL_TIMEOUT
    )

    local code, headers, status =
        socket.skip(
            1,
            http.request{
                url = url,
                method = "GET",
                headers = {
                    ["Accept-Encoding"] = "identity",
                },
                sink = ltn12.sink.file(file),
            }
        )

    socketutil:reset_timeout()

    if headers == nil then
        os.remove(temporary_path)

        return false,
            status or code or "Network unreachable"
    end

    if code ~= 200 then
        os.remove(temporary_path)

        return false,
            "HTTP "
            .. tostring(code)
            .. ": "
            .. tostring(status or "Download failed")
    end

    local attributes =
        lfs.attributes(temporary_path)

    if not attributes
        or attributes.mode ~= "file"
        or not attributes.size
        or attributes.size <= 0
    then
        os.remove(temporary_path)

        return false, "Downloaded file is empty"
    end

    os.remove(destination)

    local renamed, rename_error =
        os.rename(
            temporary_path,
            destination
        )

    if not renamed then
        os.remove(temporary_path)

        return false,
            "Could not save downloaded file: "
            .. tostring(rename_error)
    end

    return true, nil
end

function EreaderSync:syncBooks(manifest)
    local result = {
        remote = 0,
        existing = 0,
        downloaded = 0,
        failed = 0,
        errors = {},
    }

    if not manifest.books then
        return result
    end

    result.remote = #manifest.books

    for _, book in ipairs(manifest.books) do
        local file_name =
            self:safeFileName(book.name)

        if not file_name then
            result.failed = result.failed + 1

            table.insert(
                result.errors,
                "Invalid filename"
            )
        elseif not book.download_url then
            result.failed = result.failed + 1

            table.insert(
                result.errors,
                file_name
                .. ": missing download URL"
            )
        else
            local destination =
                BOOKS_DIR
                .. "/"
                .. file_name

            if self:fileExists(destination) then
                result.existing =
                    result.existing + 1
            else
                local ok, err =
                    self:downloadFile(
                        book.download_url,
                        destination
                    )

                if ok then
                    result.downloaded =
                        result.downloaded + 1
                else
                    result.failed =
                        result.failed + 1

                    table.insert(
                        result.errors,
                        file_name
                        .. ": "
                        .. tostring(err)
                    )
                end
            end
        end
    end

    return result
end

function EreaderSync:refreshLibrary()
    if self.ui
        and self.ui.file_chooser
        and self.ui.file_chooser.refreshPath
    then
        self.ui.file_chooser:refreshPath()
    end
end

function EreaderSync:onEreaderSyncAll()
    UIManager:show(
        InfoMessage:new{
            text =
                "Ereader Sync\n\n"
                .. "Syncing...",
            timeout = 1,
        }
    )

    local manifest, manifest_error =
        self:fetchManifest()

    if not manifest then
        UIManager:show(
            InfoMessage:new{
                text =
                    "Ereader Sync\n\n"
                    .. "Sync failed.\n\n"
                    .. tostring(manifest_error),
            }
        )

        return true
    end

    local books =
        self:syncBooks(manifest)

    self:refreshLibrary()

    local message =
        "Ereader Sync\n\n"
        .. "Books\n"
        .. "Downloaded: "
        .. tostring(books.downloaded)
        .. "\n"
        .. "Already on Kindle: "
        .. tostring(books.existing)
        .. "\n"
        .. "Failed: "
        .. tostring(books.failed)

    if books.failed > 0 then
        message =
            message
            .. "\n\nErrors:\n"
            .. table.concat(
                books.errors,
                "\n"
            )
    end

    message =
        message
        .. "\n\n"
        .. "Wallpapers: not synced yet"

    UIManager:show(
        InfoMessage:new{
            text = message,
        }
    )

    return true
end

function EreaderSync:onEreaderSyncStatus()
    local manifest, err =
        self:fetchManifest()

    if not manifest then
        UIManager:show(
            InfoMessage:new{
                text =
                    "Ereader Sync\n\n"
                    .. "Connection failed.\n\n"
                    .. tostring(err),
            }
        )

        return true
    end

    local remote_book_count =
        manifest.books
        and #manifest.books
        or 0

    local remote_wallpaper_count =
        manifest.wallpapers
        and #manifest.wallpapers
        or 0

    local local_book_count = 0

    for file_name in lfs.dir(BOOKS_DIR) do
        if file_name
            and file_name:lower():match("%.epub$")
        then
            local_book_count =
                local_book_count + 1
        end
    end

    UIManager:show(
        InfoMessage:new{
            text =
                "Ereader Sync\n\n"
                .. "Server: connected\n\n"
                .. "Books\n"
                .. "Remote: "
                .. tostring(remote_book_count)
                .. "\n"
                .. "Local: "
                .. tostring(local_book_count)
                .. "\n\n"
                .. "Remote wallpapers: "
                .. tostring(remote_wallpaper_count)
                .. "\n\n"
                .. "Books: "
                .. BOOKS_DIR
                .. "\n"
                .. "Wallpapers: "
                .. WALLPAPERS_DIR,
        }
    )

    return true
end

return EreaderSync