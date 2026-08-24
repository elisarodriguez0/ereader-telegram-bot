local Dispatcher = require("dispatcher")
local InfoMessage = require("ui/widget/infomessage")
local UIManager = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local JSON = require("json")
local ltn12 = require("ltn12")
local socket = require("socket")
local http = require("socket.http")
local socketutil = require("socketutil")
local _ = require("gettext")

local config = require("config")

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

function EreaderSync:onEreaderSyncAll()
    UIManager:show(
        InfoMessage:new{
            text =
                "Ereader Sync\n\n"
                .. "Plugin is connected.\n\n"
                .. "Sync all will be implemented next.",
        }
    )

    return true
end

function EreaderSync:onEreaderSyncStatus()
    local manifest, err = self:fetchManifest()

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

    local book_count =
        manifest.books and #manifest.books or 0

    local wallpaper_count =
        manifest.wallpapers and #manifest.wallpapers or 0

    UIManager:show(
        InfoMessage:new{
            text =
                "Ereader Sync\n\n"
                .. "Server: connected\n"
                .. "Remote books: "
                .. tostring(book_count)
                .. "\n"
                .. "Remote wallpapers: "
                .. tostring(wallpaper_count)
                .. "\n\n"
                .. "Books: /mnt/us/Books\n"
                .. "Wallpapers: /mnt/us/screensaver",
        }
    )

    return true
end

return EreaderSync