"use strict";
import { AvatarService } from "./avatarService";
import { Address, fnVoid, Hash } from "./commonTypes";
import { ContractWrapperBase, DecodedLogEntryEvent } from "./contractWrapperBase";
import { Utils } from "./utils";
import { DaoCreatorFactory } from "./wrappers/daocreator";
import { ForgeOrgConfig, InitialSchemesSetEventResult, SetSchemesConfig } from "./wrappers/daocreator";
import { WrapperService } from "./wrapperService";

/**
 * Helper class and factory for DAOs.
 */
export class DAO {

  /**
   * Returns the promise of a new DAO
   * @param {NewDaoConfig} opts Configuration of the new DAO
   */
  public static async new(opts: NewDaoConfig): Promise<DAO> {

    let daoCreator;

    if (opts.daoCreator) {
      daoCreator = await DaoCreatorFactory.at(opts.daoCreator);
    } else {
      daoCreator = WrapperService.wrappers.DaoCreator;
    }

    const result = await daoCreator.forgeOrg(opts);

    const avatarAddress = result.getValueFromTx("_avatar", "NewOrg");

    await daoCreator.setSchemes(Object.assign({ avatar: avatarAddress }, opts));

    return DAO.at(avatarAddress);
  }

  /**
   * Returns the promise of a DAO at the given address.  Throws an exception if not found.
   * @param avatarAddress The DAO's address
   */
  public static async at(avatarAddress: Address): Promise<DAO> {
    const dao = new DAO();

    const avatarService = new AvatarService(avatarAddress);
    dao.avatar = await avatarService.getAvatar();
    dao.controller = await avatarService.getController();
    dao.hasUController = avatarService.isUController;
    dao.token = await avatarService.getNativeToken();
    dao.reputation = await avatarService.getNativeReputation();

    return dao;
  }

  /**
   * Returns the promise of the DAOstack Genesis avatar address, or undefined if not found
   */
  public static async getGenesisDao(daoCreatorAddress: Address): Promise<string> {
    return new Promise<string>(
      async (resolve: (address: Address) => void, reject: (ex: any) => void): Promise<void> => {
        try {
          const daoCreator =
            daoCreatorAddress ?
              await WrapperService.factories.DaoCreator.at(daoCreatorAddress) : WrapperService.wrappers.DaoCreator;
          let avatarAddress;
          const event = daoCreator.InitialSchemesSet({}, { fromBlock: 0 });
          /**
           * this first DAO returned will be DAOstack
           */
          event.get((err: any, log: Array<DecodedLogEntryEvent<InitialSchemesSetEventResult>>) => {
            avatarAddress = log[0].args._avatar;
            resolve(avatarAddress);
          });
        } catch (ex) {
          reject(ex);
        }
      });
  }

  /**
   * TruffleContract for the DAO's Avatar
   */
  public avatar: any;
  /**
   * TruffleContract for the DAO's controller (Controller or UController by default, see DAO.hasUController)
   */
  public controller: any;
  /**
   * `true` if the DAO is using Arc's universal controller
   */
  public hasUController: boolean;
  /**
   * TruffleContract for the DAO's native token (DAOToken by default)
   */
  public token: any;
  /**
   * TruffleContract for the DAO's native reputation (Reputation)
   */
  public reputation: any;

  /**
   * Returns the promise of all of the schemes registered into this DAO, as Array<DaoSchemeInfo>
   * @param name Optionally filter by the name of a scheme, like "SchemeRegistrar"
   */
  public async getSchemes(name?: string): Promise<Array<DaoSchemeInfo>> {
    const schemes = await this._getSchemes();
    if (name) {
      return schemes.filter((s: DaoSchemeInfo) => s.wrapper.name && (s.wrapper.name === name));
    } else {
      return schemes;
    }
  }
  /**
   * Returns the promise of all os the global constraints currently registered into this DAO,
   * as Array<DaoGlobalConstraintInfo>
   * @param name Optionally filter by the name of a global constraint, like "TokenCapGC"
   */
  public async getGlobalConstraints(name?: string): Promise<Array<DaoGlobalConstraintInfo>> {
    // return the global constraints registered on this controller satisfying the contract spec
    // return all global constraints if name is not given
    const constraints = await this._getConstraints();
    if (name) {
      return constraints.filter((s: DaoGlobalConstraintInfo) => s.wrapper.name && (s.wrapper.name === name));
    } else {
      return constraints;
    }
  }

  /**
   * Returns whether the scheme with the given address is registered to this DAO's controller
   */
  public async isSchemeRegistered(schemeAddress: Address): Promise<boolean> {
    return await this.controller.isSchemeRegistered(schemeAddress, this.avatar.address);
  }

  /**
   * Returns whether the global constraint with the given address is registered to this DAO's controller
   */
  public async isGlobalConstraintRegistered(gc: Address): Promise<boolean> {
    return await this.controller.isGlobalConstraintRegistered(gc, this.avatar.address);
  }

  /**
   * Returns the promise of the name of the DAO as stored in the Avatar
   * @return {Promise<string>}
   */
  public async getName(): Promise<string> {
    return Utils.getWeb3().toUtf8(await this.avatar.orgName());
  }

  /**
   * Returns the promise of the  token name for the DAO as stored in the native token
   * @return {Promise<string>}
   */
  public async getTokenName(): Promise<string> {
    return await this.token.name();
  }

  /**
   * Returns  the promise of the token symbol for the DAO as stored in the native token
   * @return {Promise<string>}
   */
  public async getTokenSymbol(): Promise<string> {
    return await this.token.symbol();
  }

  /**
   * Returns promise of schemes currently in this DAO as Array<DaoSchemeInfo>
   */
  private async _getSchemes(): Promise<Array<DaoSchemeInfo>> {
    const foundSchemes = new Map<string, DaoSchemeInfo>();
    const controller = this.controller;
    const avatar = this.avatar;

    const registerSchemeEvent = controller.RegisterScheme(
      {},
      { fromBlock: 0, toBlock: "latest" }
    );

    await new Promise((resolve: fnVoid): void => {
      registerSchemeEvent.get((
        err: any,
        log: DecodedLogEntryEvent<ControllerRegisterSchemeEventLogEntry> |
          Array<DecodedLogEntryEvent<ControllerRegisterSchemeEventLogEntry>>) =>

        this._handleSchemeEvent(log, foundSchemes)
          .then((): void => {
            resolve();
          })
      );
    });

    const registeredSchemes = [];

    for (const scheme of foundSchemes.values()) {
      if (await controller.isSchemeRegistered(scheme.address, avatar.address)) {
        registeredSchemes.push(scheme);
      }
    }

    return registeredSchemes;
  }

  private async _handleSchemeEvent(
    log: DecodedLogEntryEvent<ControllerRegisterSchemeEventLogEntry> |
      Array<DecodedLogEntryEvent<ControllerRegisterSchemeEventLogEntry>>,
    schemesMap: Map<string, DaoSchemeInfo>
  ): Promise<void> {

    if (!Array.isArray(log)) {
      log = [log];
    }
    const count = log.length;
    for (let i = 0; i < count; i++) {
      const address = log[i].args._scheme;
      const wrapper = WrapperService.wrappersByAddress.get(address);

      const schemeInfo: DaoSchemeInfo = {
        address,
        // will be undefined if not an Arc scheme deployed by the running version of Arc.js
        // TODO: this should be aware of previously-deployed schemes
        wrapper,
      };

      // dedup
      schemesMap.set(address, schemeInfo);
    }
  }

  /**
   * Returns promise of global constraints currently in this DAO, as DaoGlobalConstraintInfo
   */
  private async _getConstraints(): Promise<Array<DaoGlobalConstraintInfo>> {
    const foundConstraints = new Map<string, DaoGlobalConstraintInfo>(); // <string, DaoGlobalConstraintInfo>
    const controller = this.controller;

    const event = controller.AddGlobalConstraint(
      {},
      { fromBlock: 0, toBlock: "latest" }
    );

    await new Promise((resolve: fnVoid): void => {
      event.get((
        err: any,
        log: DecodedLogEntryEvent<ControllerAddGlobalConstraintsEventLogEntry> |
          Array<DecodedLogEntryEvent<ControllerAddGlobalConstraintsEventLogEntry>>) =>

        this._handleConstraintEvent(log, foundConstraints).then(() => {
          resolve();
        })
      );
    });

    const registeredConstraints = [];

    for (const gc of foundConstraints.values()) {
      if (await this.isGlobalConstraintRegistered(gc.address)) {
        registeredConstraints.push(gc);
      }
    }

    return registeredConstraints;
  }

  private async _handleConstraintEvent(
    log: DecodedLogEntryEvent<ControllerAddGlobalConstraintsEventLogEntry> |
      Array<DecodedLogEntryEvent<ControllerAddGlobalConstraintsEventLogEntry>>,
    constraintsMap: Map<string, DaoGlobalConstraintInfo>
  ): Promise<void> {
    if (!Array.isArray(log)) {
      log = [log];
    }
    const count = log.length;
    for (let i = 0; i < count; i++) {
      const address = log[i].args._globalConstraint;
      const paramsHash = log[i].args._params;
      const wrapper = WrapperService.wrappersByAddress.get(address);

      const info: DaoGlobalConstraintInfo = {
        address,
        paramsHash,
        // will be undefined if not an Arc GC deployed by the running version of Arc.js
        // TODO: this should be aware of previously-deployed GCs
        wrapper,
      };

      // dedup
      constraintsMap.set(address, info);
    }
  }
}

export interface NewDaoConfig extends ForgeOrgConfig, SetSchemesConfig {
  /**
   * The DaoCreator to use.  Default is the DaoCreator supplied in this release of Arc.js.
   */
  daoCreator?: string;
}

/**
 * Returned from DAO.getSchemes
 */
export interface DaoSchemeInfo {
  /**
   * Scheme address
   */
  address: string;
  /**
   * Wrapper class for the scheme if it was deployed by the running version of Arc.js
   */
  wrapper?: ContractWrapperBase;
}

/********************************
 * Returned from DAO.getGlobalConstraints
 */
export interface DaoGlobalConstraintInfo {
  /**
   * Global constraint address
   */
  address: string;
  /**
   * Wrapper class for the constraint if it was deployed by the running version of Arc.js
   */
  wrapper: ContractWrapperBase;
  /**
   * hash of the constraint parameters
   */
  paramsHash: string;
}

export interface ControllerAddGlobalConstraintsEventLogEntry {
  _globalConstraint: Address;
  _params: Hash;
}

export interface ControllerRegisterSchemeEventLogEntry {
  _scheme: Address;
}
