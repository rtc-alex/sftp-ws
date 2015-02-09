﻿/// <reference path="sftp-packet.ts" />
/// <reference path="sftp-misc.ts" />
/// <reference path="sftp-api.ts" />

import packet = require("./sftp-packet");
import misc = require("./sftp-misc");
import api = require("./sftp-api");
import events = require("events");

import IStats = api.IStats;
import IItem = api.IItem;
import SftpPacket = packet.SftpPacket;
import SftpPacketWriter = packet.SftpPacketWriter;
import SftpPacketReader = packet.SftpPacketReader;
import SftpFlags = misc.SftpFlags;
import SftpStatus = misc.SftpStatus;
import SftpAttributes = misc.SftpAttributes;
import SftpItem = misc.SftpItem;
import EventEmitter = events.EventEmitter;

interface SftpRequest {
    callback: Function;
    responseParser: (reply: SftpPacket, callback: Function) => void;
}

export class SftpClientCore extends EventEmitter implements api.IFilesystem {

    private _stream: WritableStream;
    private _id: number;
    private _requests: SftpRequest[];
    private _ready: boolean;

    private _maxReadBlockLength: number;
    private _maxWriteBlockLength: number;

    private getRequest(type: number): SftpPacketWriter {
        var request = new SftpPacketWriter(this._maxWriteBlockLength + 1024); //TODO: cache buffers

        request.type = type;
        request.id = this._id;

        if (type == SftpPacket.INIT) {
            if (this._id != null)
                throw new Error("Already initialized");
            this._id = 1;
        } else {
            this._id = (this._id + 1) & 0xFFFFFFFF;
        }

        request.start();
        return request;
    }

    private writeStats(packet: SftpPacketWriter, attrs?: IStats): void {
        var pattrs = new SftpAttributes();
        pattrs.from(attrs);
        pattrs.write(packet);
    }

    constructor(stream: WritableStream, server_ident_raw: string) {
        super();
        this._stream = stream;
        this._id = null;
        this._ready = false;
        this._requests = [];

        this._maxWriteBlockLength = 32 * 1024;
        this._maxReadBlockLength = 256 * 1024;
    }


    private execute(request: SftpPacketWriter, callback: Function, responseParser: (response: SftpPacketReader, callback: Function) => void): void {

        if (typeof callback !== 'function') {
            // use dummy callback to prevent having to check this later
            callback = function () { };
        }

        // write packet length
        var length = request.position;
        request.buffer.writeInt32BE(length - 4, 0, true);

        if (typeof this._requests[request.id] !== 'undefined')
            throw new Error("Duplicate request");

        this._stream.write(request.buffer.slice(0, length));

        this._requests[request.id] = { callback: callback, responseParser: responseParser };

    }

    _parse(data: NodeBuffer): void {
        var response = new SftpPacketReader(data);

        var request = this._requests[response.id];

        if (typeof request === 'undefined')
            throw new Error("Unknown response ID");

        delete this._requests[response.id];

        request.responseParser.call(this, response, request.callback);
    }

    end(): void {

    }

    _init(callback?: (err: Error) => any): void {
        var request = this.getRequest(SftpPacket.INIT);

        request.writeInt32(3); // SFTPv3

        this.execute(request, callback, (response, cb) => {

            if (response.type != SftpPacket.VERSION) {
                callback(new Error("Protocol violation"));
                return;
            }

            var version = response.readInt32();
            if (version != 3) {
                callback(new Error("Protocol violation"));
                return;
            }

            this._ready = true;
            callback(null);
        });
    }

    open(path: string, flags: string, attrs?: IStats, callback?: (err: Error, handle: any) => any): void {
        path = this.toPath(path, 'path');

        var request = this.getRequest(SftpPacket.OPEN);

        request.writeString(path);
        request.writeInt32(SftpFlags.toFlags(flags));
        this.writeStats(request, attrs);

        this.execute(request, callback, this.parseHandle);
    }

    close(handle: any, callback?: (err: Error) => any): void {
        handle = this.toHandle(handle);

        var request = this.getRequest(SftpPacket.CLOSE);

        request.writeHandle(handle);

        this.execute(request, callback, this.parseStatus);
    }

    read(handle: any, buffer: NodeBuffer, offset: number, length: number, position: number, callback?: (err: Error, bytesRead: number, buffer: NodeBuffer) => any): void {
        handle = this.toHandle(handle);
        this.checkBuffer(buffer, offset, length);
        this.checkPosition(position);

        // make sure the length is within reasonable limits
        if (length > this._maxReadBlockLength)
            length = this._maxReadBlockLength;

        var request = this.getRequest(SftpPacket.READ);
        
        request.writeHandle(handle);
        request.writeInt64(position);
        request.writeInt32(length);

        this.execute(request, callback, (response, cb) => this.parseData(response, <any>cb, buffer, offset, length));
    }

    write(handle: any, buffer: NodeBuffer, offset: number, length: number, position: number, callback?: (err: Error) => any): void {
        handle = this.toHandle(handle);
        this.checkBuffer(buffer, offset, length);
        this.checkPosition(position);

        if (length > this._maxWriteBlockLength)
            throw new Error("Length exceeds maximum allowed data block length");

        var request = this.getRequest(SftpPacket.WRITE);
        
        request.writeHandle(handle);
        request.writeInt64(position);
        request.writeData(buffer.slice(offset, offset + length));

        this.execute(request, callback, this.parseStatus);
    }

    lstat(path: string, callback?: (err: Error, attrs: IStats) => any): void {
        path = this.toPath(path, 'path');

        this.command(SftpPacket.LSTAT, [path], callback, this.parseAttribs);
    }

    fstat(handle: any, callback?: (err: Error, attrs: IStats) => any): void {
        handle = this.toHandle(handle);

        var request = this.getRequest(SftpPacket.FSTAT);

        request.writeHandle(handle);

        this.execute(request, callback, this.parseAttribs);
    }

    setstat(path: string, attrs: IStats, callback?: (err: Error) => any): void {
        path = this.toPath(path, 'path');

        var request = this.getRequest(SftpPacket.SETSTAT);

        request.writeString(path);
        this.writeStats(request, attrs);

        this.execute(request, callback, this.parseStatus);
    }

    fsetstat(handle: any, attrs: IStats, callback?: (err: Error) => any): void {
        handle = this.toHandle(handle);

        var request = this.getRequest(SftpPacket.FSETSTAT);

        request.writeHandle(handle);
        this.writeStats(request, attrs);

        this.execute(request, callback, this.parseStatus);
    }

    opendir(path: string, callback?: (err: Error, handle: any) => any): void {
        path = this.toPath(path, 'path');

        this.command(SftpPacket.OPENDIR, [path], callback, this.parseHandle);
    }

    readdir(handle: any, callback?: (err: Error, items: IItem[]) => any): void {
        handle = this.toHandle(handle);

        var request = this.getRequest(SftpPacket.READDIR);

        request.writeHandle(handle);

        this.execute(request, callback, this.parseItems);
    }

    unlink(path: string, callback?: (err: Error) => any): void {
        path = this.toPath(path, 'path');

        this.command(SftpPacket.REMOVE, [path], callback, this.parseStatus);
    }

    mkdir(path: string, attrs?: IStats, callback?: (err: Error) => any): void {
        path = this.toPath(path, 'path');

        var request = this.getRequest(SftpPacket.MKDIR);

        request.writeString(path);
        this.writeStats(request, attrs);

        this.execute(request, callback, this.parseStatus);
    }

    rmdir(path: string, callback?: (err: Error) => any): void {
        path = this.toPath(path, 'path');

        this.command(SftpPacket.RMDIR, [path], callback, this.parseStatus);
    }

    realpath(path: string, callback?: (err: Error, resolvedPath: string) => any): void {
        path = this.toPath(path, 'path');

        this.command(SftpPacket.REALPATH, [path], callback, this.parsePath);
    }

    stat(path: string, callback?: (err: Error, attrs: IStats) => any): void {
        path = this.toPath(path, 'path');

        this.command(SftpPacket.STAT, [path], callback, this.parseAttribs);
    }

    rename(oldPath: string, newPath: string, callback?: (err: Error) => any): void {
        oldPath = this.toPath(oldPath, 'oldPath');
        newPath = this.toPath(newPath, 'newPath');

        this.command(SftpPacket.RENAME, [oldPath, newPath], callback, this.parseStatus);
    }

    readlink(path: string, callback?: (err: Error, linkString: string) => any): void {
        path = this.toPath(path, 'path');

        this.command(SftpPacket.READLINK, [path], callback, this.parsePath);
    }

    symlink(targetPath: string, linkPath: string, callback?: (err: Error) => any): void {
        targetPath = this.toPath(targetPath, 'targetPath');
        linkPath = this.toPath(linkPath, 'linkPath');

        this.command(SftpPacket.SYMLINK, [targetPath, linkPath], callback, this.parseStatus);
    }

    private toHandle(handle: { _handle: NodeBuffer; _this: SftpClient }): NodeBuffer {
        if (typeof handle === 'object') {
            if (SftpPacket.isBuffer(handle._handle) && handle._this == this)
                return handle._handle;
        } else if (handle == null || typeof handle === 'undefined') {
            throw new Error("Missing handle");
        }

        throw new Error("Invalid handle");
    }

    private toPath(path: string, name: string): string {
        if (typeof path !== 'string') {
            if (path == null || typeof path === 'undefined')
                throw new Error("Missing " + name);

            if (typeof path === 'function')
                throw new Error("Invalid " + name);

            path = <string>new String(path);
        }

        if (path.length == 0)
            throw new Error("Empty " + name);

        return path;
    }

    private checkBuffer(buffer: NodeBuffer, offset: number, length: number): void {
        if (!SftpPacket.isBuffer(buffer))
            throw new Error("Invalid buffer");

        if (typeof offset !== 'number' || offset < 0)
            throw new Error("Invalid offset");

        if (typeof length !== 'number' || length < 0)
            throw new Error("Invalid length");

        if ((offset + length) > buffer.length)
            throw new Error("Offset or length is out of bands");
    }

    private checkPosition(position: number): void {
        if (typeof position !== 'number' || position < 0 || position > 0x7FFFFFFFFFFFFFFF)
            throw new Error("Invalid position");
    }

    private command(command: number, args: string[], callback: Function, responseParser: (response: SftpPacketReader, callback: Function) => void): void {
        var request = this.getRequest(command);

        for (var i = 0; i < args.length; i++) {
            request.writeString(args[i]);
        }

        this.execute(request, callback, responseParser);
    }

    private readStatus(response: SftpPacketReader): Error {
        var code = response.readInt32();
        var message = response.readString();
        if (code == SftpStatus.OK)
            return null;

        var error = new Error("SFTP error " + code + ": " + message);
        error['code'] = code;
        return error;
    }

    private checkResponse(response: SftpPacketReader, expectedType: number, callback: Function): boolean {
        if (response.type == SftpPacket.STATUS) {
            var error = this.readStatus(response);
            if (error != null) {
                callback(error);
                return false;
            }
        }

        if (response.type != expectedType)
            throw new Error("Unexpected packet received");

        return true;
    }

    private parseStatus(response: SftpPacketReader, callback?: (err: Error) => any): void {
        if (!this.checkResponse(response, SftpPacket.STATUS, callback))
            return;

        callback(null);
    }

    private parseAttribs(response: SftpPacketReader, callback?: (err: Error, attrs: IStats) => any): void {
        if (!this.checkResponse(response, SftpPacket.ATTRS, callback))
            return;

        var attrs = new SftpAttributes(response);

        callback(null, attrs);
    }

    private parseHandle(response: SftpPacketReader, callback?: (err: Error, handle: any) => any): void {
        if (!this.checkResponse(response, SftpPacket.HANDLE, callback))
            return;

        var data = response.readData();
        var handle = new Buffer(data.length);
        data.copy(handle);

        callback(null, { _handle: handle, _this: this });
    }

    private parsePath(response: SftpPacketReader, callback?: (err: Error, path?: string) => any): void {
        if (!this.checkResponse(response, SftpPacket.NAME, callback))
            return;

        var count = response.readInt32();
        if (count != 1)
            throw new Error("Invalid response");

        var path = response.readString();

        callback(null, path);
    }

    private parseData(response: SftpPacketReader, callback: (err: Error, bytesRead: number, buffer: NodeBuffer) => any, buffer: NodeBuffer, offset: number, length: number): void {
        if (!this.checkResponse(response, SftpPacket.DATA, callback))
            return;

        var data = response.readData();

        if (data.length > length)
            throw new Error("Received too much data");

        length = data.length;

        data.copy(buffer, offset, 0, length);
        callback(null, length, buffer.slice(offset, offset + length)); //TODO: make sure that this corresponds to the behavior of fs.read
    }

    private parseItems(response: SftpPacketReader, callback?: (err: Error, items: IItem[]) => any): void {

        if (response.type == SftpPacket.STATUS) {
            var error = this.readStatus(response);
            if (error != null) {
                if (error['code'] == SftpStatus.EOF)
                    callback(null, null);
                else
                    callback(error, null);
                return;
            }
        }

        if (response.type != SftpPacket.NAME)
            throw new Error("Unexpected packet received");

        var count = response.readInt32();

        var items: SftpItem[] = [];
        for (var i = 0; i < count; i++) {
            items[i] = new SftpItem(response);
        }

        callback(null, items);
    }

}


export class SftpClient extends SftpClientCore {

    constructor(stream: WritableStream, server_ident_raw: string) {
        super(stream, server_ident_raw);
    }

    readdir(path: string, callback?: (err: Error, items: IItem[]) => any)
    readdir(handle: any, callback?: (err: Error, items: IItem[]) => any): void {

        if (typeof handle !== 'string')
            return super.readdir(handle, callback);

        var path = <string>handle;
        var list: IItem[] = [];

        var next = (err, items: IItem[]) => {

            if (err != null) {
                this.close(handle);
                callback(err, list);
                return;
            }

            if (items == null) {
                this.close(handle, err => {
                    callback(err, list);
                });
                return;
            }

            list = list.concat(items);
            super.readdir(handle, next);
        };

        this.opendir(path, (err, h) => {
            if (err != null) {
                callback(err, null);
                return;
            }

            handle = h;
            next(null, []);
        });

    }

}